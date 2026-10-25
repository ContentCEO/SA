import "server-only";
import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { callStructured } from "@/ai/client";
import {
  sentMailBlock,
  VOICE_INSTRUCTIONS,
  VOICE_PROMPT_VERSION,
  voiceSchema,
} from "@/ai/prompts/voice.v4";
import { AiCapReachedError } from "@/ai/usage";
import { injectionCheck } from "@/ai/guards";
import { ownerFirstName } from "@/ai/prompts/draft.v9";
import {
  VOICE_EXAMPLES_INSTRUCTIONS,
  VOICE_EXAMPLES_PROMPT_VERSION,
  voiceExamplesSchema,
  voiceSettingsBlock,
} from "@/ai/prompts/voice-examples.v1";
import { voiceExamplesRequested, enqueue } from "@/jobs/client";
import { db } from "@/db";
import {
  activityLog,
  appSettings,
  businessProfiles,
  drafts,
  type Mailbox,
  mailboxes,
  users,
  type VoiceProfile,
  voiceProfiles,
  workspaces,
} from "@/db/schema";
import { sendEmail, type EmailSender } from "@/lib/email";
import { appUrl } from "@/lib/app-url";
import { MailboxAuthError, type MailboxReader } from "@/mailbox/connector";
import { logGmailUnits } from "./gmail-units";
import { serverMailboxClient } from "./mailbox-client";
import { mailboxRunning } from "./mailbox-plan";
import { jobsAllowed } from "./lifecycle";
import { acceptedIdeas } from "./edit-learning";
import { ideaChanges } from "./edit-learning-rules";
import { scrubAllowFrom, scrubText, type ScrubAllow } from "./scrub";
import { markReconnectNeeded } from "./sync";
import { splitOwnWords, wordCount } from "./voice-text";
import {
  hasVoiceContent,
  MAX_VOICE_RESTARTS,
  VOICE_RETRIES_PER_DAY,
  VOICE_RETRY_AFTER_MS,
  voiceAttempt,
  voiceAttemptAt,
  type VoiceAttempt,
} from "./voice-rules";

export const MAX_SENT_EMAILS = 200;
/** Fewer than this and there's not enough to learn from. */
export const MIN_SENT_EMAILS = 5;
const PER_EMAIL_CHARS = 1_500;
const TOTAL_CHARS = 150_000;
/** Sent mail is read in one go, so keep it gentle: Gmail refuses bursts. */
const FETCH_CONCURRENCY = 3;
/** A forward whose own note is shorter than this says nothing about how the owner writes. */
const FORWARD_MIN_WORDS = 5;
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

/** Belt and braces on top of the prompt: stored voice text must not carry customer details. */
export function scrubExample(text: string, allow?: ScrubAllow): string {
  return scrubText(text, allow);
}

/**
 * Check 24 P6: which inbox the voice is learned from. Only addresses that are on (Google access
 * works and the plan covers them, 2026-10-16): the owner's own sign-in address if it is one of
 * them, else the oldest connected (by when it was first added, so a reconnect doesn't reorder).
 */
export async function voiceMailbox(workspaceId: string): Promise<Mailbox | undefined> {
  const [mailbox] = await db()
    .select({ mailbox: mailboxes })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .where(and(eq(mailboxes.workspaceId, workspaceId), mailboxRunning()))
    .orderBy(
      sql`case when lower(${mailboxes.email}) = lower(${users.email}) then 0 else 1 end`,
      asc(mailboxes.createdAt),
    )
    .limit(1);
  return mailbox?.mailbox;
}

/** A voice is stored on the row (SQL twin of `hasVoiceContent`). */
const storedVoiceSql = sql`(coalesce(btrim(${voiceProfiles.summary}), '') <> ''
  or coalesce(btrim(${voiceProfiles.greetingStyle}), '') <> ''
  or coalesce(btrim(${voiceProfiles.signoffStyle}), '') <> ''
  or jsonb_array_length(${voiceProfiles.examples}) > 0)`;

/** What `status` says for an attempt on a row with no stored voice. */
const STATUS_FOR: Record<
  Exclude<VoiceAttempt, "ready">,
  "learning" | "not_enough_mail" | "failed"
> = {
  learning: "learning",
  not_enough_mail: "not_enough_mail",
  failed: "failed",
  capped: "failed",
  reconnect_needed: "failed",
};

/**
 * Check 24 P1: record how this attempt is going. A row that already holds a voice stays
 * "ready" whatever the attempt says (decided in SQL, so an owner's save made meanwhile counts),
 * so drafts keep the stored voice; only a row with nothing stored shows the attempt's status.
 */
async function recordAttempt(
  workspaceId: string,
  attempt: Exclude<VoiceAttempt, "ready">,
  now: Date,
) {
  const status = STATUS_FOR[attempt];
  await db()
    .insert(voiceProfiles)
    .values({ workspaceId, status, lastAttempt: attempt, lastAttemptAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: voiceProfiles.workspaceId,
      set: {
        status: sql`case when ${storedVoiceSql} then 'ready'::voice_status else ${status}::voice_status end`,
        lastAttempt: attempt,
        lastAttemptAt: now,
        updatedAt: now,
      },
    });
}

/** Check 29 P2: the owner tapped "Re-learn" (an explicit owner action): restarts count again. */
export async function resetVoiceRestarts(workspaceId: string) {
  await db()
    .update(voiceProfiles)
    .set({ restartCount: 0 })
    .where(eq(voiceProfiles.workspaceId, workspaceId));
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
  if (existing?.source === "edited" && !opts.force) {
    // A forced re-learn that died and was restarted by the backstop (which never forces): close
    // the attempt instead of leaving it at "learning" to be restarted again (the voice stays).
    if (voiceAttempt(existing) === "learning") await recordAttempt(workspaceId, "failed", now);
    return "skipped_edited";
  }

  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws || !jobsAllowed(ws, now)) return "read_only";

  const mailbox = await voiceMailbox(workspaceId);
  if (!mailbox) return "no_mailbox";

  await recordAttempt(workspaceId, "learning", now);
  try {
    const stats: LearnStats = {
      emailsRead: 0,
      forwardsSkipped: 0,
      appSentSkipped: 0,
      attackSkipped: 0,
    };
    const outcome = await learnFrom(workspaceId, mailbox, opts, now, stats, existing ?? null);
    // Counts only: never ids, addresses or text.
    console.info("voice_learn", { workspaceId, outcome, ...stats });
    return outcome;
  } catch (err) {
    // Check 29 P2: a crash never leaves the row at "learning" (the backstop would restart it
    // all day). The job's own retries still run.
    try {
      await recordAttempt(workspaceId, "failed", now);
    } catch {
      // Keep the original error.
    }
    throw err;
  }
}

type LearnStats = {
  emailsRead: number;
  forwardsSkipped: number;
  appSentSkipped: number;
  /** Check 24 P5: sent emails the attack check flagged (a forwarded "Note for the AI…"), never sent. */
  attackSkipped: number;
};

/** Gmail ids of replies sent unchanged from the app, across the workspace's mailboxes. */
async function appSentMessageIds(workspaceId: string): Promise<Set<string>> {
  const rows = await db()
    .select({ id: drafts.sentGmailMessageId })
    .from(drafts)
    .innerJoin(mailboxes, eq(mailboxes.id, drafts.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        eq(drafts.status, "sent"),
        isNotNull(drafts.sentGmailMessageId),
      ),
    );
  return new Set(rows.map((r) => r.id!));
}

async function learnFrom(
  workspaceId: string,
  mailbox: Mailbox,
  opts: VoiceDeps,
  now: Date,
  stats: LearnStats,
  existing: VoiceProfile | null,
): Promise<VoiceOutcome> {
  const reader = (opts.readerFor ?? ((m) => serverMailboxClient(m)))(mailbox);

  let bodies: string[];
  try {
    const list = await reader.listMessages({
      sentOnly: true,
      newerThanDays: 365,
      maxResults: MAX_SENT_EMAILS,
    });
    // Check 24 P3: replies the app sent exactly as drafted (by the owner's tap or autopilot) are
    // the drafter's words, not the owner's. Edited-and-sent ones keep the owner's edits.
    const appSent = await appSentMessageIds(workspaceId);
    const refs = list.messages.slice(0, MAX_SENT_EMAILS).filter((r) => {
      if (!appSent.has(r.id)) return true;
      stats.appSentSkipped++;
      return false;
    });
    const fetched: (string | null)[] = new Array(refs.length).fill(null);
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, refs.length) }, async () => {
        while (next < refs.length) {
          const i = next++;
          const m = await reader.getMessage(refs[i]!.id, { withBody: true });
          // Check 24 P2: only the owner's own words; short replies ("Sounds good") count, a
          // forward with under 5 words of the owner's is skipped (and counted).
          const own = m?.bodyText ? splitOwnWords(m.bodyText) : { text: "", forward: false };
          const words = wordCount(own.text);
          if (own.forward && words < FORWARD_MIN_WORDS) stats.forwardsSkipped++;
          fetched[i] =
            words >= 1 && !(own.forward && words < FORWARD_MIN_WORDS)
              ? own.text.slice(0, PER_EMAIL_CHARS)
              : null;
        }
      }),
    );
    bodies = [];
    let total = 0;
    for (const b of fetched) {
      if (!b || total + b.length > TOTAL_CHARS) continue;
      // Check 24 P5: a planted instruction in a forward never reaches the voice prompt.
      if (injectionCheck(b).flagged) {
        stats.attackSkipped++;
        continue;
      }
      bodies.push(b);
      total += b.length;
    }
    stats.emailsRead = bodies.length;
    logGmailUnits("voice", mailbox.id, reader);
  } catch (err) {
    if (err instanceof MailboxAuthError) {
      await markReconnectNeeded(mailbox);
      await recordAttempt(workspaceId, "reconnect_needed", now);
      return "reconnect_needed";
    }
    throw err;
  }

  if (bodies.length < MIN_SENT_EMAILS) {
    await recordAttempt(workspaceId, "not_enough_mail", now);
    return "not_enough_mail";
  }

  // Check 24 P9: whose voice to describe — the profile signature's name, else the owner's name.
  const ownerFirst = await ownerFirstNameFor(workspaceId);
  let result;
  try {
    const request = {
      workspaceId,
      role: "voice" as const,
      purpose: "voice" as const,
      promptVersion: VOICE_PROMPT_VERSION,
      maxTokens: 8192,
      system: [{ text: VOICE_INSTRUCTIONS, cache: false }],
      user: sentMailBlock(bodies, ownerFirst),
      schema: voiceSchema,
      now,
    };
    result = (await callStructured(request)) ?? (await callStructured(request));
  } catch (err) {
    if (err instanceof AiCapReachedError) {
      await recordAttempt(workspaceId, "capped", now);
      return "capped";
    }
    throw err;
  }
  if (!result) {
    await recordAttempt(workspaceId, "failed", now);
    return "failed";
  }

  // Check 24 P4: every stored text field goes through the scrub; the business's own phone and
  // website (from its signature) may stay.
  const [business] = await db()
    .select({ signature: businessProfiles.signature })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  const allow = scrubAllowFrom(business?.signature);
  const clean = (t: string, max: number) => scrubText(t, allow).slice(0, max);
  // Check 24 P5: nothing the attack check flags is stored (it would ride along in every draft).
  const safe = (t: string) => !injectionCheck(t).flagged;
  // Check 24 P9: who signs the mail — first names only, scrubbed, at most five.
  const writers = result.writers
    .map((w) => ({
      name: clean(w.name, 40).split(/\s+/)[0] ?? "",
      share: w.share,
    }))
    .filter((w) => /^[A-Za-z][A-Za-z'’-]*$/.test(w.name))
    .filter((w, i, xs) => xs.findIndex((o) => o.name.toLowerCase() === w.name.toLowerCase()) === i)
    .slice(0, 5);
  // Check 24 P9: a learned sign-off that names someone else is never the owner's. Keep the
  // owner's stored one when it names them, else none (the signature carries their name).
  const learnedSignoff = (result.signoff_style && clean(result.signoff_style, 100)) || null;
  const signoffStyle =
    ownerFirst && learnedSignoff && !signoffNames(learnedSignoff, ownerFirst)
      ? existingSignoffFor(existing, ownerFirst)
      : learnedSignoff;
  // Check 24 P7: ideas the owner said yes to keep holding after a re-learn.
  const shaped = ideaChanges(
    {
      avgLengthWords: Math.max(10, Math.min(400, Math.round(result.avg_length_words))),
      formality: result.formality,
      summary: safe(result.summary) ? clean(result.summary, 600) : "",
    },
    await acceptedIdeas(workspaceId),
  );
  const values = {
    status: "ready" as const,
    source: "learned" as const,
    summary: shaped.summary,
    greetingStyle:
      (result.greeting_style && safe(result.greeting_style) && clean(result.greeting_style, 100)) ||
      null,
    signoffStyle,
    avgLengthWords: shaped.avgLengthWords,
    formality: shaped.formality,
    phrasesUsed: result.phrases_used
      .filter(safe)
      .slice(0, 10)
      .map((p) => clean(p, 120)),
    phrasesAvoided: result.phrases_avoided
      .filter(safe)
      .slice(0, 10)
      .map((p) => clean(p, 120)),
    examples: result.examples
      .filter(safe)
      .slice(0, 5)
      .map((e) => clean(e, 600)),
    writers,
    // Check 24 P8: the samples were written for the model's length and formality; an accepted
    // idea that moved either makes them stale.
    examplesStale:
      shaped.formality !== result.formality ||
      shaped.avgLengthWords !== Math.max(10, Math.min(400, Math.round(result.avg_length_words))),
    learnedFromCount: bodies.length,
    learnedFromMailboxId: mailbox.id,
    learnedAt: now,
    updatedAt: now,
    lastAttempt: "ready",
    lastAttemptAt: now,
    restartCount: 0,
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
      detail: { emailsRead: bodies.length, writers: writers.length },
    });
  // Check 24 P8: samples written for another length or formality get rewritten from the settings.
  if (values.examplesStale) await enqueue(voiceExamplesRequested.create({ workspaceId }));
  return "ready";
}

/** Check 24 P9: the owner's first name — the profile signature's, else the account's name. */
async function ownerFirstNameFor(workspaceId: string): Promise<string | null> {
  const [row] = await db()
    .select({ signature: businessProfiles.signature, name: users.name })
    .from(workspaces)
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .leftJoin(users, eq(users.id, workspaces.ownerUserId))
    .where(eq(workspaces.id, workspaceId));
  return ownerFirstName(null, row?.signature) ?? ownerFirstName(null, row?.name) ?? null;
}

/** A sign-off names the owner when its first name-like word is theirs ("Thanks, Mike"). */
function signoffNames(signoff: string, ownerFirst: string): boolean {
  const name = ownerFirstName(signoff, null);
  return !!name && name.toLowerCase() === ownerFirst.toLowerCase();
}

/** The stored sign-off, when it names the owner; else none. */
function existingSignoffFor(existing: VoiceProfile | null, ownerFirst: string): string | null {
  const stored = existing?.signoffStyle ?? null;
  return stored && signoffNames(stored, ownerFirst) ? stored : null;
}

/** Check 24 P8: the samples from the stored settings only — nothing left stale on the row. */
export const VOICE_EXAMPLES_MAX = 5;
export const VOICE_EXAMPLE_CHARS = 600;

/**
 * Check 24 P8: five fresh sample replies from the owner's STORED voice settings (no sent mail),
 * one model call (one retry), every sample scrubbed, written only while the row is as read
 * (`updated_at` unchanged — an edit made meanwhile wins and re-flags). Unusable output twice
 * leaves the flag set. Returns what happened, counts only.
 */
export async function rewriteVoiceExamples(
  workspaceId: string,
  now: Date = new Date(),
): Promise<
  "written" | "not_stale" | "no_voice" | "read_only" | "capped" | "failed" | "edited_meanwhile"
> {
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws || !jobsAllowed(ws, now)) return "read_only";
  const [v] = await db()
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.workspaceId, workspaceId));
  if (!v || !hasVoiceContent(v)) return "no_voice";
  if (!v.examplesStale) return "not_stale";
  const [business] = await db()
    .select({ signature: businessProfiles.signature })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  let result;
  try {
    const request = {
      workspaceId,
      role: "voice" as const,
      purpose: "voice" as const,
      promptVersion: VOICE_EXAMPLES_PROMPT_VERSION,
      maxTokens: 1500,
      system: [{ text: VOICE_EXAMPLES_INSTRUCTIONS, cache: false }],
      user: voiceSettingsBlock({
        greetingStyle: v.greetingStyle,
        signoffStyle: v.signoffStyle,
        avgLengthWords: v.avgLengthWords,
        formality: v.formality,
        phrasesUsed: v.phrasesUsed,
        phrasesAvoided: v.phrasesAvoided,
        summary: v.summary,
      }),
      schema: voiceExamplesSchema,
      now,
    };
    result = (await callStructured(request)) ?? (await callStructured(request));
  } catch (err) {
    if (err instanceof AiCapReachedError) return "capped";
    throw err;
  }
  if (!result) return "failed";
  const allow = scrubAllowFrom(business?.signature);
  const examples = result.examples
    .filter((e) => !injectionCheck(e).flagged)
    .slice(0, VOICE_EXAMPLES_MAX)
    .map((e) => scrubText(e, allow).slice(0, VOICE_EXAMPLE_CHARS));
  if (examples.length < VOICE_EXAMPLES_MAX) return "failed";
  const changed = await db()
    .update(voiceProfiles)
    .set({ examples, examplesStale: false })
    .where(
      and(
        eq(voiceProfiles.workspaceId, workspaceId),
        eq(voiceProfiles.updatedAt, v.updatedAt),
        eq(voiceProfiles.examplesStale, true),
      ),
    )
    .returning({ id: voiceProfiles.workspaceId });
  return changed.length ? "written" : "edited_meanwhile";
}

type VoiceCandidate = {
  workspaceId: string;
  /**
   * never: no voice row yet · stuck: died at "learning" · gave_up: stuck after 2 restarts ·
   * retry: a first learn that failed (or hit the AI cap) over an hour ago (Check 24 P12).
   */
  reason: "never" | "stuck" | "gave_up" | "retry";
  restartCount: number;
  retryDay?: string | null;
  retriesThatDay?: number;
};

async function voiceCandidates(now: Date): Promise<VoiceCandidate[]> {
  const rows = await db()
    .select({
      workspaceId: mailboxes.workspaceId,
      backfillCompletedAt: mailboxes.backfillCompletedAt,
      voice: {
        workspaceId: voiceProfiles.workspaceId,
        status: voiceProfiles.status,
        lastAttempt: voiceProfiles.lastAttempt,
        lastAttemptAt: voiceProfiles.lastAttemptAt,
        updatedAt: voiceProfiles.updatedAt,
        restartCount: voiceProfiles.restartCount,
        retryDay: voiceProfiles.retryDay,
        retriesThatDay: voiceProfiles.retriesThatDay,
        summary: voiceProfiles.summary,
        greetingStyle: voiceProfiles.greetingStyle,
        signoffStyle: voiceProfiles.signoffStyle,
        examples: voiceProfiles.examples,
      },
      workspace: { status: workspaces.status, evaluationEndsAt: workspaces.evaluationEndsAt },
    })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .leftJoin(voiceProfiles, eq(voiceProfiles.workspaceId, mailboxes.workspaceId))
    .where(mailboxRunning());
  const stuckBefore = now.getTime() - VOICE_STUCK_AFTER_MS;
  const out = new Map<string, VoiceCandidate>();
  for (const r of rows) {
    if (!r.backfillCompletedAt || !jobsAllowed(r.workspace, now) || out.has(r.workspaceId))
      continue;
    const v = r.voice?.workspaceId ? r.voice : null;
    if (!v) {
      out.set(r.workspaceId, { workspaceId: r.workspaceId, reason: "never", restartCount: 0 });
      continue;
    }
    const attempt = voiceAttempt(v);
    const stuck = attempt === "learning" && voiceAttemptAt(v).getTime() < stuckBefore;
    if (!stuck) {
      // Check 24 P12: a first learn that failed is tried again within the hour, 3 times a day,
      // so it isn't left for the Monday refresh (maybe after the trial). Not after the stuck
      // backstop gave up (Davi was told it won't restart on its own), not with a voice stored.
      const today = now.toISOString().slice(0, 10);
      const triesToday = v.retryDay === today ? v.retriesThatDay : 0;
      if (
        (attempt === "failed" || attempt === "capped") &&
        !hasVoiceContent(v) &&
        v.restartCount < MAX_VOICE_RESTARTS &&
        voiceAttemptAt(v).getTime() < now.getTime() - VOICE_RETRY_AFTER_MS &&
        triesToday < VOICE_RETRIES_PER_DAY
      )
        out.set(r.workspaceId, {
          workspaceId: r.workspaceId,
          reason: "retry",
          restartCount: v.restartCount,
          retryDay: v.retryDay,
          retriesThatDay: v.retriesThatDay,
        });
      continue;
    }
    out.set(r.workspaceId, {
      workspaceId: r.workspaceId,
      reason: v.restartCount >= MAX_VOICE_RESTARTS ? "gave_up" : "stuck",
      restartCount: v.restartCount,
    });
  }
  return [...out.values()];
}

/**
 * Backstop for the poll: workspaces whose first read is done but whose voice
 * was never learned, or whose learn died part-way (rate limits, timeouts). A learn
 * restarted twice for being stuck is not restarted again (Check 29 P2).
 */
export async function workspacesNeedingVoice(now: Date = new Date()): Promise<string[]> {
  return (await voiceCandidates(now))
    .filter((c) => c.reason !== "gave_up")
    .map((c) => c.workspaceId);
}

/**
 * The 15-minute lifecycle step. Returns the workspaces to (re)start. A stuck learn counts a
 * restart (claimed in one conditional UPDATE, so two runs can't both count it); one stuck after
 * two restarts is marked failed instead, and Davi gets one content-free email that day.
 */
export async function restartVoiceLearns(
  now: Date = new Date(),
  deps: { send?: EmailSender } = {},
): Promise<string[]> {
  const start: string[] = [];
  for (const c of await voiceCandidates(now)) {
    if (c.reason === "never") {
      start.push(c.workspaceId);
    } else if (c.reason === "stuck") {
      const [claimed] = await db()
        .update(voiceProfiles)
        .set({ restartCount: c.restartCount + 1, lastAttemptAt: now, updatedAt: now })
        .where(
          and(
            eq(voiceProfiles.workspaceId, c.workspaceId),
            eq(voiceProfiles.restartCount, c.restartCount),
          ),
        )
        .returning({ workspaceId: voiceProfiles.workspaceId });
      if (claimed) start.push(c.workspaceId);
    } else if (c.reason === "retry") {
      // Claimed in one conditional UPDATE: two runs can't both count (or both start) a retry.
      const today = now.toISOString().slice(0, 10);
      const sameDay = c.retryDay === today;
      const [claimed] = await db()
        .update(voiceProfiles)
        .set({
          retryDay: today,
          retriesThatDay: sameDay ? (c.retriesThatDay ?? 0) + 1 : 1,
          lastAttemptAt: now,
        })
        .where(
          and(
            eq(voiceProfiles.workspaceId, c.workspaceId),
            eq(voiceProfiles.retriesThatDay, c.retriesThatDay ?? 0),
            c.retryDay ? eq(voiceProfiles.retryDay, c.retryDay) : isNull(voiceProfiles.retryDay),
          ),
        )
        .returning({ workspaceId: voiceProfiles.workspaceId });
      if (claimed) start.push(c.workspaceId);
    } else {
      await recordAttempt(c.workspaceId, "failed", now);
      console.error("voice_learn_gave_up", { workspaceId: c.workspaceId });
      await alertVoiceGaveUp(c.workspaceId, now, deps.send ?? sendEmail);
    }
  }
  return start;
}

/** "Voice learning failed twice for this account" to ADMIN_EMAIL, once per workspace per day. */
async function alertVoiceGaveUp(workspaceId: string, now: Date, send: EmailSender) {
  const to = process.env.ADMIN_EMAIL;
  if (!to) return;
  const day = now.toISOString().slice(0, 10);
  const key = `voice_failed_alert:${workspaceId}:${day}`;
  const [seen] = await db().select().from(appSettings).where(eq(appSettings.key, key));
  if (seen) return;
  const [who] = await db()
    .select({ businessName: workspaces.businessName, ownerEmail: users.email })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .where(eq(workspaces.id, workspaceId));
  const label = who?.businessName?.trim() || who?.ownerEmail || "An account";
  const text = [
    `${label}: Voice learning failed twice for this account.`,
    "It won't be restarted on its own. Drafts keep any voice already stored; the owner can tap Re-learn in Settings → Your voice.",
    `See ${appUrl("/admin")}`,
  ].join("\n\n");
  try {
    const result = await send({
      to,
      subject: `Voice learning failed twice: ${label}`,
      text,
      html: text
        .split("\n\n")
        .map(
          (p) =>
            `<p>${p.replace(/[<>&]/g, (ch) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[ch]!)}</p>`,
        )
        .join(""),
      idempotencyKey: `voice-failed-${workspaceId}-${day}`,
      replyTo: null,
    });
    if (result === "not_configured") return;
    await db().insert(appSettings).values({ key, value: now.toISOString() }).onConflictDoNothing();
  } catch (err) {
    console.error("voice_failed_alert_error", {
      workspaceId,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/** Daily: yesterday's voice alert markers aren't needed any more. */
export async function purgeVoiceAlertMarkers(now: Date = new Date()) {
  const day = now.toISOString().slice(0, 10);
  await db()
    .delete(appSettings)
    .where(
      and(
        sql`${appSettings.key} like 'voice_failed_alert:%'`,
        sql`right(${appSettings.key}, 10) < ${day}`,
      ),
    );
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
    .where(mailboxRunning());
  const due = rows.filter(
    (r) =>
      jobsAllowed(r.workspace, now) &&
      r.source !== "edited" &&
      (!r.learnedAt || r.learnedAt < weekAgo),
  );
  return [...new Set(due.map((r) => r.workspaceId))];
}
