import "server-only";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { siteConfig } from "@/config/site";
import { db } from "@/db";
import { activityLog, businessProfiles, mailboxes, users, workspaces } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { brandEmail } from "@/lib/email-layout";
import { sendEmail, type EmailSender } from "@/lib/email";
import { queueCounts } from "./drafts";
import { stopHeaders, stopLinkFor } from "./trial-email-links";
import { trialCounts } from "./first-week";
import { effectiveStatus, setupReallyPaid } from "./lifecycle";
import { usableTimeZone } from "./snooze-rules";
import {
  STOP_TRIAL_EMAILS_LABEL,
  trialEmailCopy,
  trialEmailDue,
  trialEmailFooter,
  type TrialEmailKind,
} from "./trial-email-rules";

/**
 * Trial emails (Davi, 2026-10-16). Rules and words in `trial-email-rules.ts`. Sent from the
 * 15-minute lifecycle job. Content-free: counts and the owner's own trial end time only; logs
 * carry ids, the kind and error names.
 */

/** "Stop these emails" (link or Settings): sets the flag once. True when it was on before. */
export async function stopTrialEmails(
  workspaceId: string,
  via: "link" | "settings",
  now: Date = new Date(),
): Promise<boolean> {
  const changed = await db()
    .update(workspaces)
    .set({ trialEmailsStoppedAt: now })
    .where(and(eq(workspaces.id, workspaceId), isNull(workspaces.trialEmailsStoppedAt)))
    .returning({ id: workspaces.id });
  if (changed.length) {
    await db()
      .insert(activityLog)
      .values({ workspaceId, actor: "owner", action: "trial_emails_stopped", detail: { via } });
  }
  return changed.length > 0;
}

/** Settings → Morning email: trial emails back on. */
export async function resumeTrialEmails(workspaceId: string) {
  await db()
    .update(workspaces)
    .set({ trialEmailsStoppedAt: null })
    .where(eq(workspaces.id, workspaceId));
}

/** Whether Settings should offer the switch: only while the trial emails could still come. */
export function trialEmailsMatter(
  w: Parameters<typeof effectiveStatus>[0] &
    Parameters<typeof setupReallyPaid>[0] & { stripeSubscriptionId: string | null },
  now: Date = new Date(),
): boolean {
  const status = effectiveStatus(w, now);
  return (
    (status === "evaluating" || status === "evaluation_expired") &&
    !setupReallyPaid(w) &&
    !w.stripeSubscriptionId
  );
}

// ---------------------------------------------------------------------------------------------
// Sending

export type TrialEmailRun = { sent: number; failed: number; notConfigured: boolean };

/**
 * Every 15 minutes: send whichever trial email is due (at most one per account per run). Only
 * trial accounts (evaluating) for days 2–3; only accounts whose trial ran out with no payment
 * at all for the "still here" one; never anyone who tapped Stop. Marked once Resend took it;
 * without Resend set up nothing is sent and nothing is marked.
 */
export async function sendTrialEmails(
  now: Date = new Date(),
  deps: { send?: EmailSender } = {},
): Promise<TrialEmailRun> {
  const send = deps.send ?? sendEmail;
  const rows = await db()
    .select({
      workspace: workspaces,
      ownerEmail: users.email,
      digestHour: businessProfiles.digestHour,
      timeZone: businessProfiles.timeZone,
    })
    .from(workspaces)
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .leftJoin(businessProfiles, eq(businessProfiles.workspaceId, workspaces.id))
    .where(
      and(
        inArray(workspaces.status, ["evaluating", "evaluation_expired"]),
        isNull(workspaces.trialEmailsStoppedAt),
        // Only someone who connected Gmail has a trial to hear about.
        sql`exists (select 1 from ${mailboxes} where ${mailboxes.workspaceId} = ${workspaces.id})`,
      ),
    );
  const run: TrialEmailRun = { sent: 0, failed: 0, notConfigured: false };
  for (const r of rows) {
    const w = r.workspace;
    const timeZone = usableTimeZone(r.timeZone);
    const kind = trialEmailDue(
      {
        status: effectiveStatus(w, now),
        evaluationStartedAt: w.evaluationStartedAt,
        evaluationEndsAt: w.evaluationEndsAt,
        paidAnything: !!w.setupPaidVia || !!w.setupPaidAt || !!w.stripeSubscriptionId,
        stoppedAt: w.trialEmailsStoppedAt,
        sent: w.trialEmailsSent,
        digestHour: r.digestHour ?? 7,
        timeZone,
      },
      now,
    );
    if (!kind) continue;
    const link = stopLinkFor(w.id);
    // Never one without its way out.
    if (!link) continue;
    try {
      const [started, waiting] = await Promise.all([trialCounts(w), queueCounts(w.id, now)]);
      const copy = trialEmailCopy(kind, {
        counts: { ...started, waitingDrafts: waiting.drafts, needsYou: waiting.needsYou },
        queueUrl: appUrl("/queue"),
        billingUrl: appUrl("/billing"),
        endsAt: w.evaluationEndsAt ?? undefined,
        timeZone,
        now,
      });
      const { text, html } = brandEmail({
        serif: copy.serif,
        heavy: copy.heavy,
        lines: copy.lines,
        button: copy.button,
        footer: trialEmailFooter({
          operatorFirstName: siteConfig.operator.split(" ")[0]!,
          phone: siteConfig.phone,
        }),
        stopLink: { label: STOP_TRIAL_EMAILS_LABEL, url: link },
      });
      const outcome = await send({
        to: r.ownerEmail,
        subject: copy.subject,
        text,
        html,
        idempotencyKey: `trial-${w.id}-${kind}`,
        headers: stopHeaders(link),
      });
      if (outcome === "not_configured") {
        run.notConfigured = true;
        return run;
      }
      if (await markSent(w.id, kind)) run.sent++;
    } catch (err) {
      // Tried again on the next run; the error's name only.
      run.failed++;
      console.error("trial_email_failed", {
        workspaceId: w.id,
        kind,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return run;
}

/** Once ever: only the run that adds the kind logs it. */
async function markSent(workspaceId: string, kind: TrialEmailKind): Promise<boolean> {
  const [row] = await db()
    .update(workspaces)
    .set({ trialEmailsSent: sql`array_append(${workspaces.trialEmailsSent}, ${kind})` })
    .where(
      and(eq(workspaces.id, workspaceId), sql`not (${kind} = any(${workspaces.trialEmailsSent}))`),
    )
    .returning({ id: workspaces.id });
  if (!row) return false;
  await db()
    .insert(activityLog)
    .values({ workspaceId, actor: "squared_away", action: "trial_email_sent", detail: { kind } });
  return true;
}
