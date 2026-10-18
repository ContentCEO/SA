import Link from "next/link";
import { auth } from "@/auth";
import { siteConfig } from "@/config/site";
import { daysPhrase } from "@/lib/trial-words";
import { TrialClock } from "./trial-clock";
import { getWorkspaceForUser } from "@/server/accounts";
import type { Workspace } from "@/db/schema";
import {
  PAUSED_STILL_BILLED_LINE,
  planEndingSoon,
  setupCallSentence,
  shortDate,
} from "@/server/billing-rules";
import { workspaceTimeZone } from "@/server/snooze";
import { queueCounts } from "@/server/drafts";
import { trialCounts } from "@/server/first-week";
import { isLastDay, trialSoFarLine, waitingLine } from "@/server/first-week-rules";
import {
  effectiveStatus,
  evaluationClock,
  setupReallyPaid,
  trialLengthDays,
} from "@/server/lifecycle";
import { freeMonthBanner, freeMonthRunning } from "@/server/referral-rules";
import { freeMonthView, viewChanges } from "@/server/referrals";

function Contact() {
  const support = process.env.SUPPORT_EMAIL;
  return (
    <>
      Call {siteConfig.operator.split(" ")[0]} at{" "}
      <a href={`tel:${siteConfig.phone}`} className="font-semibold underline underline-offset-4">
        {siteConfig.phone}
      </a>
      {support ? (
        <>
          {" "}
          or email{" "}
          <a href={`mailto:${support}`} className="font-semibold underline underline-offset-4">
            {support}
          </a>
        </>
      ) : null}
      .
    </>
  );
}

/**
 * Plan #47: the running free month, bordered like the trial clock (not inverted: it isn't a
 * problem). Only reads the database when a free month is set on the workspace.
 */
async function FreeMonthCard({ workspace, now }: { workspace: Workspace; now: Date }) {
  if (!freeMonthRunning(workspace, now)) return null;
  const view = await freeMonthView(workspace.id);
  const banner = freeMonthBanner({
    workspace,
    reward: view.running,
    changes: viewChanges(view, workspace.plan),
    timeZone: view.timeZone,
    now,
  });
  if (!banner) return null;
  return (
    <section
      aria-label="Your free month"
      className="flex flex-col gap-1 rounded-xl border-2 border-charcoal p-4"
    >
      <p className="font-semibold">{banner.line}</p>
      {banner.link ? (
        <Link
          href={banner.link.href}
          className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
        >
          {banner.link.label}
        </Link>
      ) : null}
    </section>
  );
}

/**
 * Where the account stands, on every signed-in screen. Explains, never hides:
 * during the three days the owner sees the clock; after it, why things stopped.
 */
export async function StatusBanner() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const workspace = await getWorkspaceForUser(session.user.id);
  if (!workspace) return null;
  const now = new Date();
  const status = effectiveStatus(workspace, now);

  if (status === "evaluating") {
    const clock = evaluationClock(workspace, now);
    if (!clock) return null;
    // Round 2 (FW F2): the last day asks plainly, with what the trial did and a real button.
    const soFar = isLastDay(clock.msLeft) ? trialSoFarLine(await trialCounts(workspace)) : null;
    return <TrialClock clock={clock} soFar={soFar} />;
  }

  const inverted = (title: string, body: React.ReactNode, action?: string) => (
    <section role="status" className="sa-inverted flex flex-col gap-2 rounded-xl p-4">
      <p className="text-lg font-black">{title}</p>
      <p>{body}</p>
      {action ? (
        <Link
          href="/billing"
          className="inline-flex min-h-tap items-center justify-center rounded-lg bg-primary px-4 font-semibold text-primary-foreground"
        >
          {action}
        </Link>
      ) : null}
    </section>
  );

  // Paid-for statuses without a real payment behind them (e.g. marked by hand before
  // 2026-10-10): sending stays off until Stripe confirms the setup payment.
  if ((status === "setup_paid" || status === "active") && !setupReallyPaid(workspace)) {
    return inverted(
      "Sending turns on once setup is paid.",
      <>
        Choose a plan to pay the one-time setup and switch sending on. Every reply still waits for
        your okay. <Contact />
      </>,
      "Choose a plan",
    );
  }
  // Check 17 P3: the owner canceled in Stripe's page; in the last week, a quiet reminder.
  const ending =
    (status === "setup_paid" || status === "active") &&
    workspace.stripeCancelAt &&
    planEndingSoon(workspace.stripeCancelAt, now) ? (
      <p role="status" className="rounded-xl border-2 border-charcoal p-4">
        Your plan ends on{" "}
        {shortDate(workspace.stripeCancelAt, await workspaceTimeZone(workspace.id))}. Nothing is
        deleted.{" "}
        <Link
          href="/billing"
          className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
        >
          Plan &amp; billing
        </Link>
      </p>
    ) : null;
  switch (status) {
    case "evaluation_expired": {
      // Round 2 (FW E7/F6): what's waiting for them, counts only.
      const waiting = waitingLine(await queueCounts(workspace.id, now));
      return inverted(
        `Your ${daysPhrase(trialLengthDays(workspace))} are up.`,
        <>
          {waiting ? (
            <>
              <span className="font-semibold">{waiting}</span>{" "}
            </>
          ) : null}
          Everything here stays as it is, read-only: Squared Away reads, drafts and sends nothing
          new. To send replies from Squared Away, choose a plan — or talk to us first. <Contact />
        </>,
        "Choose a plan",
      );
    }
    case "setup_paid":
      // A running free month is a second bordered card under this one (setup_paid isn't a
      // problem state, so it doesn't hide the free month).
      return (
        <div className="flex flex-col gap-3">
          {inverted(
            "Setup's paid. Sending is on.",
            <>
              Every reply still waits for your okay. On your setup call,{" "}
              {siteConfig.operator.split(" ")[0]} {setupCallSentence("after")}. <Contact />
            </>,
          )}
          <FreeMonthCard workspace={workspace} now={now} />
          {ending}
        </div>
      );
    case "active":
      return (
        <>
          <FreeMonthCard workspace={workspace} now={now} />
          {ending}
        </>
      );
    case "past_due":
      return inverted(
        "There's a problem with your payment.",
        <>
          Squared Away is paused until it&apos;s sorted. Nothing is deleted. <Contact />
        </>,
        "Update payment",
      );
    case "paused":
      return inverted(
        "Your account is paused.",
        <>
          Nothing new is read, drafted or sent, and nothing is deleted.{" "}
          {workspace.stripeSubscriptionId ? (
            <>{PAUSED_STILL_BILLED_LINE} Questions about it? </>
          ) : null}
          <Contact />
        </>,
      );
    case "canceled":
      return inverted(
        "Your plan is canceled.",
        <>
          Nothing new is read, drafted or sent, and nothing is deleted. <Contact />
        </>,
        "Choose a plan",
      );
    default:
      return null;
  }
}
