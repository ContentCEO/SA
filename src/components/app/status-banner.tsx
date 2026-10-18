import Link from "next/link";
import { auth } from "@/auth";
import { siteConfig } from "@/config/site";
import { daysPhrase } from "@/lib/trial-words";
import { TrialClock } from "./trial-clock";
import { getWorkspaceForUser } from "@/server/accounts";
import { PAUSED_STILL_BILLED_LINE, setupCallSentence } from "@/server/billing-rules";
import { queueCounts } from "@/server/drafts";
import { trialCounts } from "@/server/first-week";
import { isLastDay, trialSoFarLine, waitingLine } from "@/server/first-week-rules";
import {
  effectiveStatus,
  evaluationClock,
  setupReallyPaid,
  trialLengthDays,
} from "@/server/lifecycle";

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
      return inverted(
        "Setup's paid. Sending is on.",
        <>
          Every reply still waits for your okay. On your setup call,{" "}
          {siteConfig.operator.split(" ")[0]} {setupCallSentence("after")}. <Contact />
        </>,
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
