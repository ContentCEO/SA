import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { siteConfig } from "@/config/site";
import { db } from "@/db";
import { waitlist } from "@/db/schema";
import { sendEmail, type EmailSender } from "@/lib/email";
import { brandEmail } from "@/lib/email-layout";
import { normalizeEmail } from "./accounts";
import { addressKey, GROWTH_NOTIFY_TIMEOUT_MS, notifyAdmin, withTimeout } from "./growth";
import { localStamp } from "./growth-note";

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
