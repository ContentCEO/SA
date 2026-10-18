import "server-only";
import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { and, count, desc, eq, gt, gte, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, businessProfiles, mailboxes, threads, workspaces } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { sendSms, TwilioError, type SmsSender } from "@/lib/sms";
import { queueCardIds, queueMembership } from "./drafts";
import { atLocalHour, localParts, usableTimeZone } from "./snooze-rules";
import { jobsAllowed } from "./lifecycle";
import { hitLimit } from "./rate-limit";
import { recordSmsDelivery } from "./sms-deliveries";

/**
 * Text alerts to the owner's own phone (feature plan #50). Content-free like
 * the digest: counts and categories only — never a customer's name or words.
 * Opt-in, phone confirmed with a code, quiet at night, throttled, capped.
 * The owner can't reply to customers by text; texts only point to the app.
 */
export const SMS = {
  codeTtlMs: 10 * 60 * 1000,
  /** Check 19 P9: wrong guesses one code allows before it is thrown away. */
  codeMaxTries: 5,
  minGapMs: 10 * 60 * 1000,
  dailyCap: 10,
  /** Local hours when texts may go out: 7am up to 9pm. */
  quietStartHour: 21,
  quietEndHour: 7,
  /** Only fresh mail is worth a text (no alerts for a backfill of old mail). */
  freshMs: 24 * 60 * 60 * 1000,
} as const;

/** US numbers only for now: "(508) 555-1234", "508.555.1234", "+1 508 555 1234" → "+15085551234". */
export function normalizeUsPhone(input: string | null | undefined): string | null {
  const digits = (input ?? "").replace(/\D/g, "");
  const ten = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(ten)) return null;
  // Check 19 P4: toll-free and N11 codes (211, 311 … 911) never take texts.
  const area = ten.slice(0, 3);
  if (TOLL_FREE_AREA_CODES.has(area) || /^[2-9]11$/.test(area)) return null;
  return `+1${ten}`;
}

const TOLL_FREE_AREA_CODES = new Set(["800", "833", "844", "855", "866", "877", "888"]);

/**
 * Which part of the Text alerts screen shows (Check 19 P4): a confirmed number, the code box
 * (only while a code that really went out is still good), or the phone-number form.
 */
export function textsStep(
  p: {
    alertPhone: string | null;
    alertPhoneVerifiedAt: Date | null;
    smsCodeHash: string | null;
    smsCodeExpiresAt: Date | null;
  } | null,
  now: Date,
): "confirmed" | "code" | "phone" {
  if (p?.alertPhoneVerifiedAt && p.alertPhone) return "confirmed";
  if (p?.alertPhone && p.smsCodeHash && p.smsCodeExpiresAt && p.smsCodeExpiresAt > now)
    return "code";
  return "phone";
}

/** "(508) 555-1234" for display. */
export function formatUsPhone(e164: string): string {
  const d = e164.replace(/^\+1/, "");
  return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
}

const hash = (code: string) => createHash("sha256").update(code).digest("hex");

export function inQuietHours(now: Date, timeZone: string): boolean {
  const { hour } = localParts(now, timeZone);
  return hour >= SMS.quietStartHour || hour < SMS.quietEndHour;
}

/** Check 19 P7: the sentence added to the day's tenth (last) text. */
export const LAST_TEXT_OF_DAY = " That's today's last text; the rest wait in the app.";

/**
 * The text: counts and a link. Check 19 P7: when the oldest lead counted came in before the
 * owner's local midnight (held overnight, or past yesterday's cap) it says "waiting on you"
 * instead of "new"; the day's last text says so.
 */
export function leadAlertBody(
  c: { quotes: number; needsYou: number },
  url: string,
  o: { waiting?: boolean; lastToday?: boolean } = {},
): string {
  const total = c.quotes + c.needsYou;
  const fresh = o.waiting ? "" : "new ";
  const what =
    c.needsYou === 0
      ? `${c.quotes} ${fresh}quote request${c.quotes === 1 ? "" : "s"}`
      : c.quotes === 0
        ? `${c.needsYou} ${fresh}email${c.needsYou === 1 ? "" : "s"}`
        : `${total} ${fresh}emails (${c.quotes} quote request${c.quotes === 1 ? "" : "s"})`;
  const verb = o.waiting
    ? `${total === 1 ? "is" : "are"} waiting on you`
    : `need${total === 1 ? "s" : ""} you`;
  return `Squared Away: ${what} ${verb}. Open: ${url}${o.lastToday ? LAST_TEXT_OF_DAY : ""}`;
}

/** Check 19 P7: true when the oldest of these arrived before the owner's local midnight. */
export function arrivedBeforeToday(
  arrivals: (Date | null | undefined)[],
  now: Date,
  timeZone: string,
): boolean {
  const midnight = atLocalHour(now, usableTimeZone(timeZone), 0, 0);
  return arrivals.some((a) => !!a && a < midnight);
}

/**
 * Check 19 P8: how long a push or text may wait to be delivered — until the owner's 9pm (when
 * quiet hours start), at most 4 hours, never under a minute. Nothing sent before 9pm buzzes
 * after it.
 */
export function secondsUntilQuiet(now: Date, timeZone: string, max = 4 * 60 * 60): number {
  const nine = atLocalHour(now, usableTimeZone(timeZone), 0, SMS.quietStartHour);
  const left = Math.floor((nine.getTime() - now.getTime()) / 1000);
  return Math.max(60, Math.min(max, left > 0 ? left : max));
}

export class SmsError extends Error {
  constructor(
    readonly code: "phone" | "busy" | "not_configured" | "code" | "not_verified" | "send_failed",
    message: string,
  ) {
    super(message);
    this.name = "SmsError";
  }
}

async function upsertProfile(
  workspaceId: string,
  set: Partial<typeof businessProfiles.$inferInsert>,
) {
  await db()
    .insert(businessProfiles)
    .values({ workspaceId, ...set })
    .onConflictDoUpdate({ target: businessProfiles.workspaceId, set });
}

/** Step 1: text a 6-digit code to the number the owner typed. */
export async function startPhoneVerification(
  workspaceId: string,
  input: string,
  deps: { send?: SmsSender; now?: Date } = {},
) {
  const phone = normalizeUsPhone(input);
  if (!phone) throw new SmsError("phone", "That doesn't look like a US mobile number.");
  if (!(await hitLimit("smsCode", workspaceId)).allowed) {
    throw new SmsError("busy", "Too many codes. Try again in an hour.");
  }
  const now = deps.now ?? new Date();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await upsertProfile(workspaceId, {
    alertPhone: phone,
    alertPhoneVerifiedAt: null,
    smsAlertsEnabled: false,
    smsCodeHash: hash(code),
    smsCodeExpiresAt: new Date(now.getTime() + SMS.codeTtlMs),
    smsCodeTries: 0,
    smsStoppedReason: null,
  });
  // Check 19 P4: no code went out → nothing that says one did (no hash, no expiry, no number).
  const forget = () =>
    upsertProfile(workspaceId, { alertPhone: null, smsCodeHash: null, smsCodeExpiresAt: null });
  let r: Awaited<ReturnType<SmsSender>>;
  try {
    r = await (deps.send ?? sendSms)({
      to: phone,
      body: `Your Squared Away code is ${code}. It expires in 10 minutes. Reply STOP to opt out.`,
    });
  } catch (err) {
    await forget();
    // Twilio's numeric status only — never the number.
    console.error("sms_code_failed", {
      workspaceId,
      status: err instanceof TwilioError ? err.status : null,
    });
    throw new SmsError(
      "send_failed",
      "We couldn't text that number. Check it's a mobile number and try again.",
    );
  }
  if (r === "not_configured") {
    await forget();
    throw new SmsError("not_configured", "Texting isn't set up yet.");
  }
  await recordSmsDelivery(workspaceId, r, "code", now);
  return phone;
}

/** Step 2: the owner types the code back → number confirmed, alerts on. */
export async function confirmPhone(workspaceId: string, code: string, now: Date = new Date()) {
  if (!(await hitLimit("smsVerify", workspaceId)).allowed) {
    throw new SmsError("busy", "Too many tries. Try again in an hour.");
  }
  const [p] = await db()
    .select()
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  const typed = Buffer.from(hash(code.replace(/\D/g, "")));
  const stored = Buffer.from(p?.smsCodeHash ?? "");
  const live =
    !!p?.smsCodeHash &&
    !!p.smsCodeExpiresAt &&
    p.smsCodeExpiresAt > now &&
    p.smsCodeTries < SMS.codeMaxTries;
  const match = typed.length === stored.length && timingSafeEqual(typed, stored);
  if (!live) throw new SmsError("code", "That code didn't match, or it expired.");
  // Only the code that was read, and only while it has guesses left (two taps at once can't
  // both get past the fifth wrong one).
  const thisCode = and(
    eq(businessProfiles.workspaceId, workspaceId),
    eq(businessProfiles.smsCodeHash, p.smsCodeHash!),
    lt(businessProfiles.smsCodeTries, SMS.codeMaxTries),
  );
  if (!match) {
    // Check 19 P9: the fifth wrong guess throws the code away.
    const [r] = await db()
      .update(businessProfiles)
      .set({ smsCodeTries: sql`${businessProfiles.smsCodeTries} + 1` })
      .where(thisCode)
      .returning({ tries: businessProfiles.smsCodeTries });
    if (r && r.tries >= SMS.codeMaxTries) {
      await db()
        .update(businessProfiles)
        .set({ smsCodeHash: null, smsCodeExpiresAt: null })
        .where(
          and(
            eq(businessProfiles.workspaceId, workspaceId),
            eq(businessProfiles.smsCodeHash, p.smsCodeHash!),
          ),
        );
      throw new SmsError("code", "That code didn't match. Send a new one.");
    }
    throw new SmsError("code", "That code didn't match, or it expired.");
  }
  const used = await db()
    .update(businessProfiles)
    .set({
      alertPhoneVerifiedAt: now,
      smsAlertsEnabled: true,
      smsCodeHash: null,
      smsCodeExpiresAt: null,
      smsCodeTries: 0,
      smsStoppedReason: null,
      // Start from now: no texts about mail that arrived before they signed up.
      smsAlertCursor: now,
    })
    .where(thisCode)
    .returning({ id: businessProfiles.workspaceId });
  if (!used.length) throw new SmsError("code", "That code didn't match. Send a new one.");
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "sms_alerts_changed",
      detail: { enabled: true },
    });
}

export async function setSmsAlerts(workspaceId: string, enabled: boolean, now = new Date()) {
  const [p] = await db()
    .select({ verified: businessProfiles.alertPhoneVerifiedAt })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  if (enabled && !p?.verified) throw new SmsError("not_verified", "Confirm your number first.");
  await upsertProfile(workspaceId, {
    smsAlertsEnabled: enabled,
    ...(enabled ? { smsAlertCursor: now, smsStoppedReason: null } : {}),
  });
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "sms_alerts_changed",
    detail: { enabled },
  });
}

/** Forget the number entirely. */
export async function removeAlertPhone(workspaceId: string) {
  await upsertProfile(workspaceId, {
    alertPhone: null,
    alertPhoneVerifiedAt: null,
    smsAlertsEnabled: false,
    smsCodeHash: null,
    smsCodeExpiresAt: null,
  });
}

/**
 * New quote requests and emails that need the owner, sorted since `cursor`
 * (default: the last hour), fresh and still waiting on them. Shared by texts
 * and phone notifications (#36). An emergency the owner already heard about on its own
 * (replies package, B5 part 2) is left out until a later email is sorted on that thread.
 */
export async function freshLeads(workspaceId: string, cursor: Date | null, now: Date) {
  return db()
    .select({
      threadId: threads.id,
      lastMessageAt: threads.lastMessageAt,
      category: threads.category,
      needsOwner: threads.needsOwner,
      classifiedAt: threads.classifiedAt,
    })
    .from(threads)
    .innerJoin(mailboxes, eq(mailboxes.id, threads.mailboxId))
    .where(
      and(
        eq(mailboxes.workspaceId, workspaceId),
        // A Gmail address paused on the plan raises no alerts (2026-10-16).
        isNull(mailboxes.planPausedAt),
        eq(threads.inInbox, true),
        gt(threads.classifiedAt, cursor ?? new Date(now.getTime() - 60 * 60 * 1000)),
        gt(threads.lastMessageAt, new Date(now.getTime() - SMS.freshMs)),
        or(eq(threads.category, "quote_request"), eq(threads.needsOwner, true)),
        or(
          isNull(threads.emergencyAlertedAt),
          lt(threads.emergencyAlertedAt, threads.classifiedAt),
        ),
        sql`(select m.direction from messages m where m.thread_id = ${threads.id} order by m.sent_at desc limit 1) = 'in'`,
      ),
    )
    .orderBy(desc(threads.classifiedAt));
}

/**
 * Check 19 P1: new quote requests (not needs-you) that have no card on the queue yet — no
 * draft, because drafting was skipped (AI limit, a model failure) or hasn't run. Ids only.
 */
export async function quotesWithoutCard(
  workspaceId: string,
  fresh: { threadId: string; needsOwner: boolean; category: string | null }[],
  now: Date,
): Promise<string[]> {
  const quotes = fresh.filter((t) => !t.needsOwner && t.category === "quote_request");
  if (!quotes.length) return [];
  const onQueue = queueCardIds(await queueMembership(workspaceId, now));
  return quotes.map((t) => t.threadId).filter((id) => !onQueue.has(id));
}

export const leadCounts = (fresh: { needsOwner: boolean; category: string | null }[]) => ({
  needsYou: fresh.filter((t) => t.needsOwner).length,
  quotes: fresh.filter((t) => !t.needsOwner && t.category === "quote_request").length,
});

/**
 * After sorting (and every 15 minutes as a backstop): one text per batch of
 * new quote requests / emails that need the owner. At most one text every 10
 * minutes and 10 a day; nothing between 9pm and 7am (they get it at 7).
 */
export async function sendLeadAlerts(
  now: Date = new Date(),
  deps: { send?: SmsSender; workspaceId?: string } = {},
) {
  const send = deps.send ?? sendSms;
  const profiles = await db()
    .select({ profile: businessProfiles, workspace: workspaces })
    .from(businessProfiles)
    .innerJoin(workspaces, eq(workspaces.id, businessProfiles.workspaceId))
    .where(
      and(
        deps.workspaceId ? eq(businessProfiles.workspaceId, deps.workspaceId) : undefined,
        eq(businessProfiles.smsAlertsEnabled, true),
        sql`${businessProfiles.alertPhoneVerifiedAt} is not null`,
        sql`${businessProfiles.alertPhone} is not null`,
      ),
    );

  let sent = 0;
  for (const { profile: p, workspace: w } of profiles) {
    if (!jobsAllowed(w, now)) continue;
    if (inQuietHours(now, p.timeZone)) continue;
    if (p.smsLastSentAt && now.getTime() - p.smsLastSentAt.getTime() < SMS.minGapMs) continue;

    // Check 19 P7: ten a local day, counted from the owner's midnight (as the at-risk pushes).
    const dayStart = atLocalHour(now, usableTimeZone(p.timeZone), 0, 0);
    const [today] = await db()
      .select({ n: count() })
      .from(activityLog)
      .where(
        and(
          eq(activityLog.workspaceId, w.id),
          eq(activityLog.action, "sms_alert_sent"),
          gte(activityLog.createdAt, dayStart),
        ),
      );
    if ((today?.n ?? 0) >= SMS.dailyCap) continue;

    const fresh = await freshLeads(w.id, p.smsAlertCursor, now);
    if (!fresh.length) continue;

    const counts = leadCounts(fresh);
    // Check 19 P1: the link lands where the lead is — Quotes when a quote request has no
    // reply on the queue yet.
    const noCard = await quotesWithoutCard(w.id, fresh, now);
    const url = appUrl(noCard.length ? "/quotes" : "/queue");
    const newest = fresh[0]!.classifiedAt!;
    // Claim the slot first so two runs can't both text.
    const claimed = await db()
      .update(businessProfiles)
      .set({ smsLastSentAt: now, smsAlertCursor: newest })
      .where(
        and(
          eq(businessProfiles.workspaceId, w.id),
          or(
            isNull(businessProfiles.smsLastSentAt),
            lt(businessProfiles.smsLastSentAt, new Date(now.getTime() - SMS.minGapMs)),
          ),
        ),
      )
      .returning({ id: businessProfiles.workspaceId });
    if (!claimed.length) continue;

    const body = leadAlertBody(counts, url, {
      waiting: arrivedBeforeToday(
        fresh.map((f) => f.lastMessageAt),
        now,
        p.timeZone,
      ),
      lastToday: (today?.n ?? 0) + 1 >= SMS.dailyCap,
    });
    const r = await send({
      to: p.alertPhone!,
      body,
      // Check 19 P8: Twilio drops it rather than deliver it after 9pm.
      validitySec: secondsUntilQuiet(now, p.timeZone),
    });
    if (r === "not_configured") {
      // Give the slot back so nothing is lost once texting is set up.
      await db()
        .update(businessProfiles)
        .set({ smsLastSentAt: p.smsLastSentAt, smsAlertCursor: p.smsAlertCursor })
        .where(eq(businessProfiles.workspaceId, w.id));
      return { sent, notConfigured: true };
    }
    // Check 19 P6: remembered by Twilio's message id; Activity says "Texted you" only once
    // Twilio reports it delivered.
    const deliveryId = await recordSmsDelivery(w.id, r, "alert", now);
    await db()
      .insert(activityLog)
      .values({
        workspaceId: w.id,
        actor: "squared_away",
        action: "sms_alert_sent",
        detail: { ...counts, ...(deliveryId ? { deliveryId } : {}) },
        createdAt: now,
      });
    sent++;
  }
  return { sent, notConfigured: false };
}
