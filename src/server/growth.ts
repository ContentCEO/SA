import "server-only";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { growthCopy } from "@/components/marketing/growth/growth-copy";
import {
  GROWTH_HEARD_FROM_VALUES,
  GROWTH_REQUEST_VALUES,
  growthRequestLabel,
} from "@/config/growth";
import { US_STATE_CODES } from "@/config/us-states";
import { tradeLabel } from "@/config/trades";
import { db } from "@/db";
import { tradeEnum, waitlist } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { sendEmail, type EmailSender } from "@/lib/email";
import { brandEmail } from "@/lib/email-layout";
import { normalizeEmail } from "./accounts";
import {
  collapseLine,
  formatGrowthBlock,
  GROWTH_ONLY_TEAM_SIZE,
  localStamp,
  scrubMarker,
  withGrowthBlock,
} from "./growth-note";
import { isReferralCode, referralsVisible } from "./referral-rules";
import { firstTouch, NO_SOURCE, type SignupSource } from "./source-rules";
import { tradeOtherField, tradeOtherFor } from "@/lib/trade-other";
import { isTimeZone } from "./time-zone-rules";

const msg = growthCopy.errors;

/**
 * A US phone number as "617-555-0142", or null. Letters, more than 40 characters, the wrong
 * number of digits, or an area code / exchange that can't exist (starting 0 or 1) are refused.
 */
export function normalizeUsPhone(raw: string): string | null {
  if (raw.length > 40 || /\p{L}/u.test(raw)) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits)) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/** One line, no "[Growth call]" a person typed (it would look like a stored block). */
const oneLine = (v: unknown) => (typeof v === "string" ? scrubMarker(collapseLine(v)) : v);

/** The form's order, once each; "Not sure yet" (Check 3 P4) last. */
const serviceOrder = (picked: readonly string[]) =>
  GROWTH_REQUEST_VALUES.filter((v) => picked.includes(v));

/** An optional select: blank is null, anything else must be on the list. */
const blankToNull = (v: unknown) => (v === "" || v === undefined ? null : v);

/** The call-request form: plain-language messages, exactly as on the page. */
export const growthInput = z
  .object({
    name: z.preprocess(oneLine, z.string().min(1, msg.nameEmpty).max(120, msg.nameLong)),
    phone: z.string().transform((raw, ctx) => {
      if (!raw.trim()) {
        ctx.addIssue({ code: "custom", message: msg.phoneEmpty });
        return z.NEVER;
      }
      const phone = normalizeUsPhone(raw);
      if (!phone) {
        ctx.addIssue({ code: "custom", message: msg.phoneBad });
        return z.NEVER;
      }
      return phone;
    }),
    // 254 is the longest address email allows; it also keeps the key under Postgres's index limit.
    email: z
      .string()
      .trim()
      .toLowerCase()
      .min(1, msg.emailEmpty)
      .max(254, msg.emailBad)
      .email(msg.emailBad),
    trade: z.enum(tradeEnum.enumValues, { message: msg.trade }),
    /** Check 41 P4: "Which trade?" for "Another trade" (optional, one line, max 60). */
    tradeOther: tradeOtherField.optional(),
    services: z
      .array(z.enum(GROWTH_REQUEST_VALUES, { message: msg.serviceUnknown }))
      .min(1, msg.servicesNone)
      .transform(serviceOrder),
    /** Check 5 P2: how they heard (optional; a value id, never the label). */
    heardFrom: z.preprocess(
      blankToNull,
      z.enum(GROWTH_HEARD_FROM_VALUES, { message: msg.serviceUnknown }).nullable().default(null),
    ),
    /** Check 5 P2: who sent them (optional, one line, ≤80; kept only with "Another contractor"). */
    sentBy: z.preprocess(
      (v) => (typeof v === "string" ? oneLine(v) || null : (v ?? null)),
      z.string().max(80, msg.sentByLong).nullable().default(null),
    ),
    /** Check 45 P5: the state they work in (optional). */
    state: z.preprocess(
      blankToNull,
      z.enum(US_STATE_CODES, { message: msg.stateUnknown }).nullable().default(null),
    ),
    /** Check 45 P5: the browser's zone; anything that isn't a real zone is dropped, not an error. */
    timeZone: z
      .unknown()
      .optional()
      .transform((v) => (isTimeZone(v) ? v : null)),
    note: z.preprocess(
      (v) => (typeof v === "string" ? oneLine(v) || null : (v ?? null)),
      z.string().max(500, msg.noteLong).nullable(),
    ),
    /** Plan #47: the code from a referral link (?ref=). Anything malformed is dropped, not an error. */
    referralCode: z
      .unknown()
      .optional()
      .transform((v) => (isReferralCode(v) ? v : null)),
  })
  // "Who sent you?" only belongs with "Another contractor told me" (the form shows it only then).
  .transform((r) => ({ ...r, sentBy: r.heardFrom === "contractor" ? r.sentBy : null }));
export type GrowthInput = z.output<typeof growthInput>;

/**
 * Store a request in the waitlist table. A new email gets a growth-only row; an existing entry
 * gets the request as its (single) Growth block, with blanks filled in. It NEVER changes the
 * name, team size, created or invited dates, and never invites anyone.
 *
 * Plan #47 (decided 2026-10-16): a referral link's code is kept on the row only while referrals
 * are on, and an entry's first code is never replaced. It's settled (once ever) when the person
 * becomes a Growth client (`creditGrowthReferral`).
 */
export async function requestGrowthCall(
  input: GrowthInput,
  now: Date = new Date(),
  source: SignupSource = NO_SOURCE,
  /** Check 2 P3: the hidden trap field was filled; stored with a flag line, the admin still sees it. */
  opts: { trapFilled?: boolean } = {},
) {
  const email = normalizeEmail(input.email);
  const referralCode = referralsVisible() ? (input.referralCode ?? null) : null;
  const request = {
    at: localStamp(now),
    services: input.services.map(growthRequestLabel),
    phone: input.phone,
    heardFrom: input.heardFrom,
    sentBy: input.sentBy,
    state: input.state,
    timeZone: input.timeZone,
    note: input.note,
    ...(opts.trapFilled ? { trapFilled: true } : {}),
  };
  const result = await db().transaction(async (tx) => {
    const [inserted] = await tx
      .insert(waitlist)
      .values({
        email,
        name: input.name,
        phone: input.phone,
        trade: input.trade,
        tradeOther: tradeOtherFor(input.trade, input.tradeOther),
        teamSize: GROWTH_ONLY_TEAM_SIZE,
        note: formatGrowthBlock(request),
        referralCode,
        ...source,
      })
      .onConflictDoNothing()
      .returning({ email: waitlist.email });
    if (inserted) return "requested" as const;

    const [existing] = await tx
      .select()
      .from(waitlist)
      .where(eq(waitlist.email, email))
      .for("update");
    if (!existing) throw new Error("waitlist entry missing after conflict");
    const growthOnly = existing.teamSize === GROWTH_ONLY_TEAM_SIZE;
    await tx
      .update(waitlist)
      .set({
        trade: existing.trade ?? input.trade,
        tradeOther: existing.trade
          ? existing.tradeOther
          : tradeOtherFor(input.trade, input.tradeOther),
        // A growth-only row's phone only ever came from Growth: keep the newest. An app entry's
        // phone is only ever the one they gave the app form; the Growth number lives in the block,
        // so a replaced request leaves no old number behind (as the privacy policy says).
        phone: growthOnly ? input.phone : existing.phone,
        referralCode: existing.referralCode ?? referralCode,
        note: withGrowthBlock(existing.note, {
          ...request,
          nameGiven: existing.name.toLowerCase() !== input.name.toLowerCase() ? input.name : null,
          tradeGiven:
            existing.trade && existing.trade !== input.trade ? tradeLabel[input.trade] : null,
        }),
        ...firstTouch(existing, source),
      })
      .where(eq(waitlist.email, email));
    return "added_to_existing" as const;
  });
  console.info("growth_call_requested", {
    existing: result === "added_to_existing",
    services: input.services.length,
    heardFrom: input.heardFrom !== null,
  });
  return result;
}

/** Salted like ipKey, so the key can't be matched against a list of addresses. */
export function growthNotifyKey(email: string, now: Date) {
  return `growth-${addressKey(email)}-${localStamp(now).slice(0, 10)}`;
}

/** 16 hex characters of HMAC(AUTH_SECRET, address): an email key that holds no address. */
export function addressKey(email: string) {
  return createHmac("sha256", process.env.AUTH_SECRET ?? "")
    .update(normalizeEmail(email))
    .digest("hex")
    .slice(0, 16);
}

/** The form waits for the notice; a Resend that hangs must not leave the visitor on "Sending…". */
export const GROWTH_NOTIFY_TIMEOUT_MS = 5000;

/**
 * Email the admin (ADMIN_EMAIL) a content-free notice, raced against a timeout so a Resend that hangs
 * never holds anything up. Shared by Growth requests and waitlist sign-ups.
 */
export async function notifyAdmin(
  notice: {
    subject: string;
    serif: string;
    heavy: string;
    lines: readonly string[];
    button: string;
    footer: string;
    key: string;
  },
  deps: { send?: EmailSender; timeoutMs?: number } = {},
) {
  const admin = process.env.ADMIN_EMAIL;
  if (!admin) return "skipped" as const;
  const { text, html } = brandEmail({
    serif: notice.serif,
    heavy: notice.heavy,
    lines: [...notice.lines],
    button: { label: notice.button, url: appUrl("/admin#waitlist") },
    footer: notice.footer,
  });
  return withTimeout(
    (deps.send ?? sendEmail)({
      to: admin,
      subject: notice.subject,
      text,
      html,
      idempotencyKey: notice.key,
      replyTo: null,
    }),
    deps.timeoutMs ?? GROWTH_NOTIFY_TIMEOUT_MS,
  );
}

/** Rejects with a TimeoutError after `ms` (the timer is always cleared). */
export async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("Email timed out.");
      err.name = "TimeoutError";
      reject(err);
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function growthConfirmKey(email: string, now: Date) {
  return `growth-confirm-${addressKey(email)}-${localStamp(now).slice(0, 10)}`;
}

/**
 * Check 2 P2: "here's what's next" to the person who asked for a call. Only fixed words and
 * the operator's number: **nothing the visitor typed** (name, note, services), since anyone can put
 * someone else's address in the form. One per address per New York day (Resend idempotency
 * key); raced against the same timeout as the admin notice. Without Resend env it's skipped by
 * sendEmail ("not_configured"). Not a Gmail send path: it goes through Resend like the waitlist
 * confirmation.
 */
export async function sendGrowthConfirmation(
  email: string,
  deps: { send?: EmailSender; now?: Date; timeoutMs?: number } = {},
) {
  const address = normalizeEmail(email);
  const c = growthCopy.confirm;
  const { text, html } = brandEmail({
    serif: c.serif,
    heavy: c.heavy,
    lines: [...c.lines],
    footer: c.footer,
  });
  const replyTo = process.env.SUPPORT_EMAIL?.trim();
  return withTimeout(
    (deps.send ?? sendEmail)({
      to: address,
      subject: c.subject,
      text,
      html,
      idempotencyKey: growthConfirmKey(address, deps.now ?? new Date()),
      ...(replyTo ? { replyTo } : {}),
    }),
    deps.timeoutMs ?? GROWTH_NOTIFY_TIMEOUT_MS,
  );
}

/**
 * After a stored request: the admin notice and the visitor's confirmation, side by side. Never
 * throws: a failed or hanging email never fails the request. Logs the error's name only.
 */
export async function sendGrowthEmails(
  email: string,
  deps: { send?: EmailSender; now?: Date; timeoutMs?: number } = {},
) {
  const [notify, confirm] = await Promise.allSettled([
    notifyGrowthRequest(email, deps),
    sendGrowthConfirmation(email, deps),
  ]);
  const name = (r: PromiseRejectedResult) =>
    r.reason instanceof Error ? r.reason.name : "unknown";
  if (notify.status === "rejected") console.warn("growth_notify_failed", { error: name(notify) });
  if (confirm.status === "rejected") {
    console.warn("growth_confirm_failed", { error: name(confirm) });
  }
  return {
    notify: notify.status === "fulfilled" ? notify.value : ("failed" as const),
    confirm: confirm.status === "fulfilled" ? confirm.value : ("failed" as const),
  };
}

/**
 * Tell Davi a request came in. Content-free: no name, number or email address anywhere in it;
 * those stay on the admin page. One notice per person per day.
 */
export async function notifyGrowthRequest(
  email: string,
  deps: { send?: EmailSender; now?: Date; timeoutMs?: number } = {},
) {
  return notifyAdmin(
    { ...growthCopy.notify, key: growthNotifyKey(email, deps.now ?? new Date()) },
    deps,
  );
}
