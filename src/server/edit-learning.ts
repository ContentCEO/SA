import "server-only";
import { and, desc, eq, gte, isNotNull, isNull, or } from "drizzle-orm";
import { callStructured } from "@/ai/client";
import {
  EDIT_TONE_INSTRUCTIONS,
  EDIT_TONE_PROMPT_VERSION,
  editToneSchema,
  editToneTask,
  type ToneShift,
} from "@/ai/prompts/edit-tone.v1";
import { AiCapReachedError } from "@/ai/usage";
import { db } from "@/db";
import {
  activityLog,
  drafts,
  editSignals,
  mailboxes,
  voiceProfiles,
  voiceSuggestions,
  workspaces,
} from "@/db/schema";
import { editShape, proposeSuggestions, type EditSignal } from "./edit-learning-rules";
import { jobsAllowed } from "./lifecycle";

const DAY = 86_400_000;
/** Look back this far for edits (inside the 30-day text retention). */
const CAPTURE_DAYS = 25;
/** Edits that count towards a suggestion. */
const WINDOW_DAYS = 30;
/** An idea the owner answered isn't asked again for this long. */
const QUIET_DAYS = 60;

/**
 * Plan #21, step 1 (daily, before the text purge): for each reply the owner
 * edited before sending, store what the edit did — counts and yes/no in code,
 * the tone shift from the classifier model — and never the words.
 */
export async function captureEditSignals(now: Date = new Date(), limit = 50): Promise<number> {
  const rows = await db()
    .select({ draft: drafts, workspace: workspaces })
    .from(drafts)
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .leftJoin(editSignals, eq(editSignals.draftId, drafts.id))
    .where(
      and(
        eq(drafts.status, "edited_and_sent"),
        isNotNull(drafts.body),
        isNotNull(drafts.originalBody),
        gte(drafts.decidedAt, new Date(now.getTime() - CAPTURE_DAYS * DAY)),
        isNull(editSignals.draftId),
      ),
    )
    .limit(limit);
  let stored = 0;
  for (const { draft, workspace } of rows) {
    if (!jobsAllowed(workspace, now)) continue;
    const shape = editShape(draft.originalBody!, draft.body!);
    let toneShift: ToneShift | null = null;
    try {
      const r = await callStructured({
        workspaceId: workspace.id,
        role: "classify",
        promptVersion: EDIT_TONE_PROMPT_VERSION,
        maxTokens: 64,
        system: [{ text: EDIT_TONE_INSTRUCTIONS, cache: false }],
        user: editToneTask(draft.originalBody!, draft.body!),
        schema: editToneSchema,
        now,
      });
      toneShift = r?.tone_shift ?? null;
    } catch (err) {
      if (!(err instanceof AiCapReachedError)) throw err;
    }
    await db()
      .insert(editSignals)
      .values({ draftId: draft.id, workspaceId: workspace.id, ...shape, toneShift })
      .onConflictDoNothing();
    stored++;
  }
  return stored;
}

/**
 * Plan #21, step 2 (weekly): turn a month of edit signals into at most three
 * plain questions. Ideas already waiting, or answered in the last 60 days,
 * aren't asked again.
 */
export async function proposeVoiceUpdates(now: Date = new Date()): Promise<number> {
  const since = new Date(now.getTime() - WINDOW_DAYS * DAY);
  const signals = await db()
    .select()
    .from(editSignals)
    .where(gte(editSignals.createdAt, since))
    .orderBy(desc(editSignals.createdAt));
  const byWorkspace = new Map<string, EditSignal[]>();
  for (const s of signals) {
    const list = byWorkspace.get(s.workspaceId) ?? [];
    list.push({ ...s, toneShift: s.toneShift as ToneShift | null });
    byWorkspace.set(s.workspaceId, list);
  }
  let created = 0;
  for (const [workspaceId, list] of byWorkspace) {
    const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
    if (!ws || !jobsAllowed(ws, now)) continue;
    const ideas = proposeSuggestions(list);
    if (!ideas.length) continue;
    const recent = await db()
      .select({ kind: voiceSuggestions.kind })
      .from(voiceSuggestions)
      .where(
        and(
          eq(voiceSuggestions.workspaceId, workspaceId),
          or(
            eq(voiceSuggestions.status, "open"),
            gte(voiceSuggestions.decidedAt, new Date(now.getTime() - QUIET_DAYS * DAY)),
          ),
        ),
      );
    const skip = new Set(recent.map((r) => r.kind));
    for (const idea of ideas) {
      if (skip.has(idea.kind)) continue;
      await db()
        .insert(voiceSuggestions)
        .values({
          workspaceId,
          kind: idea.kind,
          text: idea.text,
          targetWords: idea.targetWords ?? null,
          createdAt: now,
        });
      created++;
    }
  }
  return created;
}

export async function openSuggestions(workspaceId: string) {
  return db()
    .select({ id: voiceSuggestions.id, kind: voiceSuggestions.kind, text: voiceSuggestions.text })
    .from(voiceSuggestions)
    .where(and(eq(voiceSuggestions.workspaceId, workspaceId), eq(voiceSuggestions.status, "open")))
    .orderBy(desc(voiceSuggestions.createdAt));
}

const SUMMARY_ADDS: Record<string, string> = {
  skip_opener: "Gets straight to the point — no warm-up sentence.",
  warmer: "Warm and friendly.",
};

/**
 * The owner's yes or no. Only a yes changes the voice profile (and marks it
 * edited, so the weekly re-learn leaves it alone). Greeting and sign-off ideas
 * change nothing by themselves: the owner types theirs in Settings.
 */
export async function decideSuggestion(
  workspaceId: string,
  id: string,
  accept: boolean,
  now: Date = new Date(),
): Promise<"accepted" | "ignored" | "type_it" | "not_found"> {
  const [s] = await db()
    .update(voiceSuggestions)
    .set({ status: accept ? "accepted" : "ignored", decidedAt: now })
    .where(
      and(
        eq(voiceSuggestions.id, id),
        eq(voiceSuggestions.workspaceId, workspaceId),
        eq(voiceSuggestions.status, "open"),
      ),
    )
    .returning();
  if (!s) return "not_found";
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: accept ? "voice_idea_accepted" : "voice_idea_ignored",
      detail: { kind: s.kind },
    });
  if (!accept) return "ignored";
  if (s.kind === "signoff" || s.kind === "greeting") return "type_it";

  const [v] = await db()
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.workspaceId, workspaceId));
  if (!v) return "accepted";
  const change: Partial<typeof voiceProfiles.$inferInsert> = { source: "edited", updatedAt: now };
  if ((s.kind === "shorter" || s.kind === "longer") && s.targetWords)
    change.avgLengthWords = s.targetWords;
  if (s.kind === "more_formal") change.formality = "formal";
  if (s.kind === "more_casual") change.formality = "casual";
  const add = SUMMARY_ADDS[s.kind];
  if (add && !(v.summary ?? "").includes(add))
    change.summary = [v.summary?.trim(), add].filter(Boolean).join(" ");
  await db().update(voiceProfiles).set(change).where(eq(voiceProfiles.workspaceId, workspaceId));
  return "accepted";
}
