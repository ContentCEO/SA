import "server-only";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { siteConfig } from "@/config/site";
import { db } from "@/db";
import { waitlist } from "@/db/schema";
import { emailErrorFields, sendEmail, type EmailSender } from "@/lib/email";
import { brandEmail } from "@/lib/email-layout";
import { normalizeEmail } from "./accounts";
import { addressKey, GROWTH_NOTIFY_TIMEOUT_MS, notifyAdmin, withTimeout } from "./growth";
import { GROWTH_ONLY_TEAM_SIZE, localStamp } from "./growth-note";

/** Davi's notice: content-free, like the Growth one. Who it is stays on the admin page. */
export const waitlistNotifyCopy = {
  subject: "New waitlist sign-up",
  serif: "new sign-up,",
  heavy: "someone joined.",
  lines: [
    "Someone joined the app waitlist on the website.",
    "Open the admin page to see who it is.",
  ],
  button: "Open admin",
  footer: "Names and numbers stay in the admin page, not in this email.",
} as const;

const firstName = siteConfig.operator.split(" ")[0];

/**
 * The visitor's "You're on the list" email. Only true statements, and **nothing the visitor
 * typed**: anyone can put someone else's address in the form, so this email must not carry text
 * a stranger chose.
 */
export const waitlistConfirmCopy = {
  subject: "You're on the Squared Away list",
  serif: "you're on the list,",
  heavy: "here's what's next.",
  lines: [
    "Thanks for joining the Squared Away waitlist.",
    `We set each shop up by hand, a few at a time. ${firstName} will call or email you to find a time.`,
    "It works with Gmail and Google Workspace today.",
    `Nothing to do until then. Questions? Call ${siteConfig.phone}.`,
  ],
  footer: "You're getting this because this address joined the waitlist on our website.",
} as const;

export function waitlistNotifyKey(email: string, now: Date) {
  return `waitlist-${addressKey(email)}-${localStamp(now).slice(0, 10)}`;
}

export function waitlistConfirmKey(email: string) {
  return `waitlist-confirm-${addressKey(email)}`;
}

type Deps = { send?: EmailSender; now?: Date; timeoutMs?: number };

/** Tell Davi someone joined (one notice per address per day). */
export async function notifyWaitlistSignup(email: string, deps: Deps = {}) {
  return notifyAdmin(
    { ...waitlistNotifyCopy, key: waitlistNotifyKey(email, deps.now ?? new Date()) },
    deps,
  );
}

/**
 * "You're on the list" to the person who joined: one per address, ever. Marked only once Resend
 * took it, so an unconfigured or failed send can go out on a later sign-up.
 */
export async function sendWaitlistConfirmation(email: string, deps: Deps = {}) {
  const address = normalizeEmail(email);
  const [row] = await db()
    .select({ sentAt: waitlist.confirmationSentAt })
    .from(waitlist)
    .where(eq(waitlist.email, address));
  if (!row) return "skipped" as const;
  if (row.sentAt) return "already_sent" as const;
  const c = waitlistConfirmCopy;
  const { text, html } = brandEmail({
    serif: c.serif,
    heavy: c.heavy,
    lines: [...c.lines],
    footer: c.footer,
  });
  const replyTo = process.env.SUPPORT_EMAIL?.trim();
  const outcome = await withTimeout(
    (deps.send ?? sendEmail)({
      to: address,
      subject: c.subject,
      text,
      html,
      idempotencyKey: waitlistConfirmKey(address),
      ...(replyTo ? { replyTo } : {}),
    }),
    deps.timeoutMs ?? GROWTH_NOTIFY_TIMEOUT_MS,
  );
  if (outcome === "sent" || outcome === "already_sent") {
    await db()
      .update(waitlist)
      .set({ confirmationSentAt: deps.now ?? new Date() })
      .where(and(eq(waitlist.email, address), isNull(waitlist.confirmationSentAt)));
  }
  return outcome;
}

/** How many "never got it" confirmations one tap sends (one a second, inside a request's time). */
export const WAITLIST_CATCHUP_PER_TAP = 8;

/** Check 18 P4: app sign-ups whose "You're on the list" email never went out (a count only). */
export async function countWaitlistNeverConfirmed(): Promise<number> {
  const [row] = await db()
    .select({ n: count() })
    .from(waitlist)
    .where(and(isNull(waitlist.confirmationSentAt), neverConfirmedFilter()));
  return row?.n ?? 0;
}

const neverConfirmedFilter = () =>
  sql`${waitlist.teamSize} is distinct from ${GROWTH_ONLY_TEAM_SIZE}`;

export type WaitlistCatchUp = {
  sent: number;
  failed: number;
  /** Still without one after this tap (another tap sends the next batch). */
  left: number;
  notConfigured: boolean;
};

/**
 * Check 18 P4: once the Resend domain is verified, send the confirmation to everyone who joined
 * before it (confirmation_sent_at null, not Growth-only), oldest first, one a second, up to
 * WAITLIST_CATCHUP_PER_TAP per tap; stops at the first "not configured". Each success is marked
 * by sendWaitlistConfirmation itself, so nothing goes twice. Logs counts only.
 */
export async function catchUpWaitlistConfirmations(
  deps: Deps & { perTap?: number; pauseMs?: number } = {},
): Promise<WaitlistCatchUp> {
  const perTap = deps.perTap ?? WAITLIST_CATCHUP_PER_TAP;
  const rows = await db()
    .select({ email: waitlist.email })
    .from(waitlist)
    .where(and(isNull(waitlist.confirmationSentAt), neverConfirmedFilter()))
    .orderBy(waitlist.createdAt)
    .limit(perTap);
  const run: WaitlistCatchUp = { sent: 0, failed: 0, left: 0, notConfigured: false };
  for (const [i, r] of rows.entries()) {
    if (i > 0) await new Promise((res) => setTimeout(res, deps.pauseMs ?? 1000));
    try {
      const outcome = await sendWaitlistConfirmation(r.email, deps);
      if (outcome === "not_configured") {
        run.notConfigured = true;
        break;
      }
      if (outcome === "sent" || outcome === "already_sent") run.sent++;
      else run.failed++;
    } catch (err) {
      run.failed++;
      console.warn("waitlist_catchup_failed", emailErrorFields(err));
    }
  }
  run.left = await countWaitlistNeverConfirmed();
  console.info("waitlist_catchup", { sent: run.sent, failed: run.failed, left: run.left });
  return run;
}

/**
 * After a new sign-up: both emails, side by side. Never throws — a failed email never fails the
 * sign-up. Logs the error's name only.
 */
export async function sendWaitlistEmails(email: string, deps: Deps = {}) {
  const [notify, confirm] = await Promise.allSettled([
    notifyWaitlistSignup(email, deps),
    sendWaitlistConfirmation(email, deps),
  ]);
  const name = (r: PromiseRejectedResult) =>
    r.reason instanceof Error ? r.reason.name : "unknown";
  if (notify.status === "rejected") console.warn("waitlist_notify_failed", { error: name(notify) });
  if (confirm.status === "rejected") {
    console.warn("waitlist_confirm_failed", { error: name(confirm) });
  }
  return {
    notify: notify.status === "fulfilled" ? notify.value : ("failed" as const),
    confirm: confirm.status === "fulfilled" ? confirm.value : ("failed" as const),
  };
}
