import "server-only";
import { eq } from "drizzle-orm";
import { callStructured } from "@/ai/client";
import { prepareBody } from "@/ai/classify";
import {
  sentMailBlock,
  VOICE_INSTRUCTIONS,
  VOICE_PROMPT_VERSION,
  voiceSchema,
} from "@/ai/prompts/voice.v2";
import { AiCapReachedError } from "@/ai/usage";
import { db } from "@/db";
import { activityLog, mailboxes, voiceProfiles, workspaces, type Mailbox } from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { MailboxAuthError, type MailboxReader } from "@/mailbox/connector";
import { createGmailReader } from "@/mailbox/gmail/api";
import { jobsAllowed } from "./lifecycle";
import { markReconnectNeeded } from "./sync";

export const MAX_SENT_EMAILS = 200;
/** Fewer than this and there's not enough to learn from. */
export const MIN_SENT_EMAILS = 5;
const PER_EMAIL_CHARS = 1_500;
const TOTAL_CHARS = 150_000;
/** Sent mail is read in one go, so keep it gentle: Gmail refuses bursts. */
const FETCH_CONCURRENCY = 3;
/** A learn that has said "learning" this long without finishing has died; start it again. */
export const VOICE_STUCK_AFTER_MS = 30 * 60_000;

export type VoiceDeps = { readerFor?: (m: Mailbox) => MailboxReader; now?: () => Date };
export type VoiceOutcome =
  | "ready"
  | "not_enough_mail"
  | "skipped_edited"
  | "failed"
  | "capped"
  | "reconnect_needed"
  | "no_mailbox"
  | "read_only";

/** Belt and braces on top of the prompt: examples must not carry customer details. */
export function scrubExample(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\(?\b\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]")
    .replace(/\$\s?\d[\d,]*(\.\d{2})?/g, "[price]")
    .replace(
      /\b\d{1,5}\s+[A-Z][a-z]+(\s[A-Z][a-z]+)*\s(St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Way|Blvd)\b/g,
      "[address]",
    )
    .trim();
}

async function setStatus(
  workspaceId: string,
  status: "learning" | "not_enough_mail" | "failed",
  now: Date,
) {
  await db()
    .insert(voiceProfiles)
    .values({ workspaceId, status, updatedAt: now })
    .onConflictDoUpdate({ target: voiceProfiles.workspaceId, set: { status, updatedAt: now } });
}

/**
 * Learn the owner's voice from up to 200 recent sent emails. Sent mail is read
 * into memory for this one call and never written to the database.
 * `force` (the owner tapped "Re-learn") overwrites their manual edits;
 * the weekly refresh does not.
 */
export async function learnVoice(
  workspaceId: string,
  opts: VoiceDeps & { force?: boolean } = {},
): Promise<VoiceOutcome> {
  const now = opts.now?.() ?? new Date();
  const [existing] = await db()
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.workspaceId, workspaceId));
  if (existing?.source === "edited" && !opts.force) return "skipped_edited";

  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws || !jobsAllowed(ws, now)) return "read_only";

  const [mailbox] = await db()
    .select()
    .from(mailboxes)
    .where(eq(mailboxes.workspaceId, workspaceId));
  if (!mailbox || mailbox.status !== "active") return "no_mailbox";

  await setStatus(workspaceId, "learning", now);
  const reader = (
    opts.readerFor ??
    ((m) => createGmailReader({ refreshToken: decryptSecret(m.encryptedRefreshToken) }))
  )(mailbox);

  let bodies: string[];
  try {
    const list = await reader.listMessages({
      query: "in:sent newer_than:365d",
      maxResults: MAX_SENT_EMAILS,
    });
    const refs = list.messages.slice(0, MAX_SENT_EMAILS);
    const fetched: (string | null)[] = new Array(refs.length).fill(null);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, refs.length) }, async () => {
        while (next < refs.length) {
          const i = next++;
          const m = await reader.getMessage(refs[i]!.id, { withBody: true });
          const text = m?.bodyText ? prepareBody(m.bodyText).slice(0, PER_EMAIL_CHARS) : "";
          fetched[i] = text.length >= 20 ? text : null;
        }
      }),
    );
    bodies = [];
    let total = 0;
    for (const b of fetched) {
      if (!b || total + b.length > TOTAL_CHARS) continue;
      bodies.push(b);
      total += b.length;
    }
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      await setStatus(workspaceId, "failed", now);
      return "reconnect_needed";
    }
    throw err;
  }

  if (bodies.length < MIN_SENT_EMAILS) {
    await setStatus(workspaceId, "not_enough_mail", now);
    return "not_enough_mail";
  }

  let result;
  try {
    const request = {
      workspaceId,
      role: "voice" as const,
      promptVersion: VOICE_PROMPT_VERSION,
      maxTokens: 4096,
      system: [{ text: VOICE_INSTRUCTIONS, cache: false }],
      user: sentMailBlock(bodies),
      schema: voiceSchema,
      now,
    };
    result = (await callStructured(request)) ?? (await callStructured(request));
  } catch (err) {
    if (err instanceof AiCapReachedError) {
      await setStatus(workspaceId, "failed", now);
      return "capped";
    }
    throw err;
  }
  if (!result) {
    await setStatus(workspaceId, "failed", now);
    return "failed";
  }

  const values = {
    status: "ready" as const,
    source: "learned" as const,
    summary: result.summary.trim().slice(0, 600),
    greetingStyle: result.greeting_style?.trim().slice(0, 100) || null,
    signoffStyle: result.signoff_style?.trim().slice(0, 100) || null,
    avgLengthWords: Math.max(10, Math.min(400, Math.round(result.avg_length_words))),
    formality: result.formality,
    phrasesUsed: result.phrases_used.slice(0, 10).map((p) => p.trim().slice(0, 120)),
    phrasesAvoided: result.phrases_avoided.slice(0, 10).map((p) => p.trim().slice(0, 120)),
    examples: result.examples.slice(0, 5).map((e) => scrubExample(e).slice(0, 600)),
    learnedFromCount: bodies.length,
    learnedAt: now,
    updatedAt: now,
  };
  await db()
    .insert(voiceProfiles)
    .values({ workspaceId, ...values })
    .onConflictDoUpdate({ target: voiceProfiles.workspaceId, set: values });
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "squared_away",
      action: "voice_learned",
      detail: { emailsRead: bodies.length },
    });
  return "ready";
}

/**
 * Backstop for the poll: workspaces whose first read is done but whose voice
 * was never learned, or whose learn died part-way (rate limits, timeouts).
 */
export async function workspacesNeedingVoice(now: Date = new Date()): Promise<string[]> {
  const rows = await db()
    .select({
      workspaceId: mailboxes.workspaceId,
      backfillCompletedAt: mailboxes.backfillCompletedAt,
      status: voiceProfiles.status,
      updatedAt: voiceProfiles.updatedAt,
      workspace: { status: workspaces.status, evaluationEndsAt: workspaces.evaluationEndsAt },
    })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .leftJoin(voiceProfiles, eq(voiceProfiles.workspaceId, mailboxes.workspaceId))
    .where(eq(mailboxes.status, "active"));
  const stuckBefore = now.getTime() - VOICE_STUCK_AFTER_MS;
  const due = rows.filter(
    (r) =>
      r.backfillCompletedAt &&
      jobsAllowed(r.workspace, now) &&
      (!r.status || (r.status === "learning" && (r.updatedAt?.getTime() ?? 0) < stuckBefore)),
  );
  return [...new Set(due.map((r) => r.workspaceId))];
}

/** Workspaces due for the weekly refresh: learned (not hand-edited) and older than a week. */
export async function workspacesDueForVoiceRefresh(now: Date = new Date()) {
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const rows = await db()
    .select({
      workspaceId: mailboxes.workspaceId,
      learnedAt: voiceProfiles.learnedAt,
      source: voiceProfiles.source,
      workspace: { status: workspaces.status, evaluationEndsAt: workspaces.evaluationEndsAt },
    })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .leftJoin(voiceProfiles, eq(voiceProfiles.workspaceId, mailboxes.workspaceId))
    .where(eq(mailboxes.status, "active"));
  const due = rows.filter(
    (r) =>
      jobsAllowed(r.workspace, now) &&
      r.source !== "edited" &&
      (!r.learnedAt || r.learnedAt < weekAgo),
  );
  return [...new Set(due.map((r) => r.workspaceId))];
}
