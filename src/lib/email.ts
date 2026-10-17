import "server-only";
import { and, eq, like, lt } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";

export type OutgoingEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Same key within 24h = Resend sends it once, so job retries can't double-send. */
  idempotencyKey: string;
  /** Where a reply to this email goes (Resend `reply_to`). Only set from SUPPORT_EMAIL. */
  replyTo?: string;
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
export const sendEmail: EmailSender = async (email) => {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from) return "not_configured";
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
      ...(email.replyTo ? { reply_to: email.replyTo } : {}),
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
  if (!res.ok) throw new Error(`Resend ${res.status}.`);
  await recordSent(email.idempotencyKey);
  return "sent";
};
