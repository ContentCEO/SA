import "server-only";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { activityLog, mailboxes, users, workspaces } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { brandEmail } from "@/lib/email-layout";
import { sendEmail, type EmailSender, emailErrorFields } from "@/lib/email";
import { jobsAllowed } from "./lifecycle";

/** A second reminder if Gmail is still disconnected this long after the first alert. */
export const ACCESS_REMINDER_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
export const MAX_ACCESS_ALERTS = 2;

export function accessLostEmail(mailboxEmail: string, reminder: boolean) {
  const subject = reminder
    ? "Reminder: reconnect Gmail to Squared Away"
    : "Squared Away lost access to your Gmail";
  const { text, html } = brandEmail({
    serif: reminder ? "still waiting," : "heads up,",
    heavy: "reconnect gmail.",
    lines: [
      `Google stopped letting Squared Away read ${mailboxEmail}, so new emails aren't being sorted or drafted.`,
      "Reconnecting takes about a minute. Nothing was lost — we pick up where we left off.",
    ],
    button: { label: "Reconnect Gmail", url: appUrl("/settings/gmail") },
    footer: reminder
      ? "This is the last reminder we'll send about this."
      : "Google sometimes ends access on its own, for example after a password change.",
  });
  return { subject, text, html };
}

/**
 * Every 15 minutes: email the owner when a mailbox loses Google access, and
 * once more two days later if it's still disconnected. Never more than two per
 * loss; reconnecting resets the count. The email names only the owner's own
 * mailbox — no customer details.
 */
export async function sendAccessLostAlerts(
  now: Date = new Date(),
  deps: { send?: EmailSender } = {},
) {
  const send = deps.send ?? sendEmail;
  const reminderBefore = new Date(now.getTime() - ACCESS_REMINDER_AFTER_MS);
  const rows = await db()
    .select({ mailbox: mailboxes, workspace: workspaces, ownerEmail: users.email })
    .from(mailboxes)
    .innerJoin(workspaces, eq(workspaces.id, mailboxes.workspaceId))
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .where(
      and(
        eq(mailboxes.status, "reconnect_needed"),
        // A Gmail address paused on the plan isn't nagged about (2026-10-16).
        isNull(mailboxes.planPausedAt),
        or(
          eq(mailboxes.accessAlertsSent, 0),
          and(
            gt(mailboxes.accessAlertsSent, 0),
            lt(mailboxes.accessAlertsSent, MAX_ACCESS_ALERTS),
            lt(mailboxes.accessLostAt, reminderBefore),
          ),
        ),
      ),
    );

  let sent = 0;
  let failed = 0;
  for (const r of rows) {
    if (!jobsAllowed(r.workspace, now)) continue;
    const n = r.mailbox.accessAlertsSent;
    // Check 18 P1: one owner's refused email (a Resend 403 while EMAIL_FROM is
    // onboarding@resend.dev, a bad address) never stops the others or the rest of the
    // 15-minute job. Nothing is marked, so the next run tries this owner again. Ids and the
    // error's name only.
    try {
      const email = accessLostEmail(r.mailbox.email, n > 0);
      const outcome = await send({
        to: r.ownerEmail,
        ...email,
        idempotencyKey: `access-lost-${r.mailbox.id}-${(r.mailbox.accessLostAt ?? now).getTime()}-${n}`,
      });
      if (outcome === "not_configured") return { sent, failed, notConfigured: true };
      // "already_sent": an earlier try with this key got through (sendEmail holds our own record
      // of its 2xx) but this count didn't save. The owner has the email, so it counts as sent.
      // The reminder clock runs from the first alert.
      await db()
        .update(mailboxes)
        .set({ accessAlertsSent: n + 1, ...(n === 0 ? { accessLostAt: now } : {}) })
        .where(and(eq(mailboxes.id, r.mailbox.id), eq(mailboxes.accessAlertsSent, n)));
      await db()
        .insert(activityLog)
        .values({
          workspaceId: r.workspace.id,
          actor: "squared_away",
          action: "access_alert_sent",
          detail: { mailboxId: r.mailbox.id, reminder: n > 0 },
        });
      sent++;
    } catch (err) {
      failed++;
      console.error("access_alert_failed", {
        mailboxId: r.mailbox.id,
        ...emailErrorFields(err),
      });
    }
  }
  return { sent, failed, notConfigured: false };
}
