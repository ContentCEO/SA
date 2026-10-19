import "server-only";
import { and, eq, like, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";

/**
 * Check 18 P2: a refusal from Resend, with the HTTP status and nothing else. The message
 * never carries Resend's own text (it can echo the address), and callers log `status` as a
 * number beside the error's name, so a 403 from the test sender can be told from a 5xx.
 */
export class ResendError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Resend ${status}.`);
    this.name = "ResendError";
    this.status = status;
  }
}

/** What a sender's catch block logs: the error's name, plus the Resend status when there is one. */
export function emailErrorFields(err: unknown): { error: string; status?: number } {
  if (err instanceof ResendError) return { error: err.name, status: err.status };
  return { error: err instanceof Error ? err.name : "unknown" };
}

/** Content-free tally of refusals per UTC day: `email-refused:<YYYY-MM-DD>` → {"403": 3}. */
export const REFUSED_TALLY_PREFIX = "email-refused:";
/** Kept two weeks, then the daily purge drops it. */
export const REFUSED_TALLY_KEEP_DAYS = 14;

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** One more refusal with this status today. Never throws (the refusal itself is what matters). */
async function tallyRefusal(status: number, now: Date = new Date()) {
  const key = REFUSED_TALLY_PREFIX + utcDay(now);
  const field = String(status);
  try {
    await db()
      .insert(appSettings)
      .values({ key, value: JSON.stringify({ [field]: 1 }) })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: {
          value: sql`(coalesce(${appSettings.value}::jsonb, '{}'::jsonb) || jsonb_build_object(${field}::text, coalesce((${appSettings.value}::jsonb ->> ${field})::int, 0) + 1))::text`,
          updatedAt: now,
        },
      });
  } catch (err) {
    console.error("email_refused_tally_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

export type RefusedTally = { total: number; byStatus: Record<string, number> };

/** Refusals over the last `days` UTC days (today included), by status. Counts only. */
export async function refusedTally(days = 7, now: Date = new Date()): Promise<RefusedTally> {
  const since = REFUSED_TALLY_PREFIX + utcDay(new Date(now.getTime() - (days - 1) * 86_400_000));
  const rows = await db()
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(
      and(like(appSettings.key, `${REFUSED_TALLY_PREFIX}%`), sql`${appSettings.key} >= ${since}`),
    );
  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(r.value);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    for (const [status, n] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof n !== "number" || !/^\d{3}$/.test(status)) continue;
      byStatus[status] = (byStatus[status] ?? 0) + n;
      total += n;
    }
  }
  return { total, byStatus };
}

/** Daily: drop refusal tallies older than two weeks. */
export async function purgeEmailRefusedTallies(now: Date = new Date()) {
  const keep =
    REFUSED_TALLY_PREFIX + utcDay(new Date(now.getTime() - REFUSED_TALLY_KEEP_DAYS * 86_400_000));
  await db()
    .delete(appSettings)
    .where(
      and(like(appSettings.key, `${REFUSED_TALLY_PREFIX}%`), sql`${appSettings.key} < ${keep}`),
    );
}

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Same key within 24h = Resend sends it once, so job retries can't double-send. */
  idempotencyKey: string;
  /**
   * Where a reply to this email goes (Resend `reply_to`). Check 18 P5: left out, an owner-facing
   * email gets SUPPORT_EMAIL, else ADMIN_EMAIL (both env), so a reply reaches a person and not
   * the sending address. `null` means none on purpose: notices addressed to ADMIN_EMAIL itself.
   */
  replyTo?: string | null;
  /**
   * Extra headers (Resend `headers`): only the one-click unsubscribe pair on trial emails
   * (`List-Unsubscribe` / `List-Unsubscribe-Post`), never anything an email or a person typed.
   */
  headers?: Record<string, string>;
};

/**
 * - `sent`: Resend took it (or replayed an earlier send of the same key and body).
 * - `already_sent`: Resend refused a body that differs from the one it already took under this
 *   key (409 `invalid_idempotent_request`) **and** we hold our own record that an earlier try
 *   with this key got a 2xx (`email-sent:<key>` in app_settings). Our summaries mention how
 *   long things have waited, so a retry after a send whose bookkeeping failed rebuilds a
 *   slightly different body; the owner already has the email, so the caller records it as
 *   done instead of retrying all day. Without our record the 409 stays an error: Resend's docs
 *   don't say whether a key is kept when the first request was refused (say a 403 while
 *   EMAIL_FROM is still onboarding@resend.dev), and an email that never went out must never
 *   be marked sent.
 * - `not_configured`: no Resend key / sender address; nothing was sent.
 */
export type SendOutcome = "sent" | "already_sent" | "not_configured";

export type EmailSender = (email: OutgoingEmail) => Promise<SendOutcome>;

/**
 * Resend's 409 for a key reused with a different body. Only this one means "already sent":
 * `concurrent_idempotent_requests` (the first request is still running and may yet fail) and
 * any other 409 stay errors, so nothing is marked done on a guess.
 */
const ALREADY_SENT_409 = "invalid_idempotent_request";

/** Our record that Resend took a request under this idempotency key (content-free). */
const SENT_RECORD_PREFIX = "email-sent:";
/** Resend keeps a key 24 hours; our record outlives that, then the daily purge drops it. */
export const SENT_RECORD_KEEP_MS = 2 * 24 * 60 * 60 * 1000;

async function recordSent(idempotencyKey: string) {
  try {
    await db()
      .insert(appSettings)
      .values({ key: SENT_RECORD_PREFIX + idempotencyKey, value: new Date().toISOString() })
      .onConflictDoNothing();
  } catch (err) {
    // The email went out; the caller still marks it. Only a later "already sent" loses its proof
    // (that retry then fails loudly instead of being marked done).
    console.error("email_sent_record_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

async function hasSentRecord(idempotencyKey: string): Promise<boolean> {
  const [row] = await db()
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, SENT_RECORD_PREFIX + idempotencyKey))
    .limit(1);
  return Boolean(row);
}

/** Daily: drop sent records older than Resend's 24-hour key window (with a day to spare). */
export async function purgeEmailSentRecords(now: Date = new Date()) {
  const cutoff = new Date(now.getTime() - SENT_RECORD_KEEP_MS);
  await db()
    .delete(appSettings)
    .where(and(like(appSettings.key, `${SENT_RECORD_PREFIX}%`), lt(appSettings.updatedAt, cutoff)));
}

async function errorName(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.json();
    if (body && typeof body === "object" && "name" in body && typeof body.name === "string") {
      return body.name;
    }
  } catch {
    // Not JSON: treat it as an ordinary failure.
  }
  return null;
}

/**
 * Our own emails to owners (the digest), via Resend's HTTP API. Needs
 * RESEND_API_KEY and EMAIL_FROM ("Squared Away <hello@yourdomain>"); without
 * them nothing is sent and the caller is told so.
 */
/** Check 18 P5: the Reply-To for an owner-facing email — SUPPORT_EMAIL, else ADMIN_EMAIL, else none. */
export function defaultReplyTo(env: {
  SUPPORT_EMAIL?: string | undefined;
  ADMIN_EMAIL?: string | undefined;
}): string | undefined {
  return env.SUPPORT_EMAIL?.trim() || env.ADMIN_EMAIL?.trim() || undefined;
}

export const sendEmail: EmailSender = async (email) => {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) return "not_configured";
  const replyTo =
    email.replyTo === null
      ? undefined
      : email.replyTo ||
        defaultReplyTo({
          SUPPORT_EMAIL: process.env.SUPPORT_EMAIL,
          ADMIN_EMAIL: process.env.ADMIN_EMAIL,
        });
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      "idempotency-key": email.idempotencyKey,
    },
    body: JSON.stringify({
      from,
      to: [email.to],
      subject: email.subject,
      html: email.html,
      text: email.text,
      ...(replyTo ? { reply_to: replyTo } : {}),
      ...(email.headers ? { headers: email.headers } : {}),
    }),
  });
  if (
    res.status === 409 &&
    (await errorName(res)) === ALREADY_SENT_409 &&
    (await hasSentRecord(email.idempotencyKey))
  ) {
    return "already_sent";
  }
  if (!res.ok) {
    await tallyRefusal(res.status);
    throw new ResendError(res.status);
  }
  await recordSent(email.idempotencyKey);
  return "sent";
};
