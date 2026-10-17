import "server-only";
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import { callStructured } from "@/ai/client";
import {
  sentMailBlock,
  VOICE_INSTRUCTIONS,
  VOICE_PROMPT_VERSION,
  voiceSchema,
} from "@/ai/prompts/voice.v2";
import { AiCapReachedError } from "@/ai/usage";
import { db } from "@/db";
import {
  activityLog,
  appSettings,
  businessProfiles,
  drafts,
  mailboxes,
  users,
  voiceProfiles,
  workspaces,
  type Mailbox,
} from "@/db/schema";
import { decryptSecret } from "@/lib/crypto";
import { sendEmail, type EmailSender } from "@/lib/email";
import { appUrl } from "@/lib/app-url";
import { MailboxAuthError, type MailboxReader } from "@/mailbox/connector";
import { createGmailReader } from "@/mailbox/gmail/api";
import { mailboxRunning } from "./mailbox-plan";
import { jobsAllowed } from "./lifecycle";
import { acceptedIdeas } from "./edit-learning";
import { ideaChanges } from "./edit-learning-rules";
import { scrubAllowFrom, scrubText, type ScrubAllow } from "./scrub";
import { markReconnectNeeded } from "./sync";
import { splitOwnWords, wordCount } from "./voice-text";
import { MAX_VOICE_RESTARTS, voiceAttempt, voiceAttemptAt, type VoiceAttempt } from "./voice-rules";

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
  if (existing?.source === "edited" && !opts.force) return "skipped_edited";

  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, workspaceId));
  if (!ws || !jobsAllowed(ws, now)) return "read_only";

  const mailbox = await voiceMailbox(workspaceId);
  if (!mailbox) return "no_mailbox";

  await recordAttempt(workspaceId, "learning", now);
  try {
    const stats: LearnStats = { emailsRead: 0, forwardsSkipped: 0, appSentSkipped: 0 };
    const outcome = await learnFrom(workspaceId, mailbox, opts, now, stats);
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

type LearnStats = { emailsRead: number; forwardsSkipped: number; appSentSkipped: number };

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
): Promise<VoiceOutcome> {
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
      bodies.push(b);
      total += b.length;
    }
    stats.emailsRead = bodies.length;
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
  // Check 24 P7: ideas the owner said yes to keep holding after a re-learn.
  const shaped = ideaChanges(
    {
      avgLengthWords: Math.max(10, Math.min(400, Math.round(result.avg_length_words))),
      formality: result.formality,
      summary: clean(result.summary, 600),
    },
    await acceptedIdeas(workspaceId),
  );
  const values = {
    status: "ready" as const,
    source: "learned" as const,
    summary: shaped.summary,
    greetingStyle: (result.greeting_style && clean(result.greeting_style, 100)) || null,
    signoffStyle: (result.signoff_style && clean(result.signoff_style, 100)) || null,
    avgLengthWords: shaped.avgLengthWords,
    formality: shaped.formality,
    phrasesUsed: result.phrases_used.slice(0, 10).map((p) => clean(p, 120)),
    phrasesAvoided: result.phrases_avoided.slice(0, 10).map((p) => clean(p, 120)),
    examples: result.examples.slice(0, 5).map((e) => clean(e, 600)),
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
      detail: { emailsRead: bodies.length },
    });
  return "ready";
}

type VoiceCandidate = {
  workspaceId: string;
  /** never: no voice row yet · stuck: died at "learning" · gave_up: stuck after 2 restarts. */
  reason: "never" | "stuck" | "gave_up";
  restartCount: number;
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
    const stuck = voiceAttempt(v) === "learning" && voiceAttemptAt(v).getTime() < stuckBefore;
    if (!stuck) continue;
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
