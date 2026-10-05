import Link from "next/link";
import { auth } from "@/auth";
import { siteConfig } from "@/config/site";
import { getWorkspaceForUser } from "@/server/accounts";
import { effectiveStatus, evaluationClock, timeLeft } from "@/server/lifecycle";

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
    return (
      <section
        aria-label="Your three days"
        className="flex flex-col gap-1 rounded-xl border-2 border-charcoal p-4"
      >
        <p className="text-lg font-black">
          Day {clock.day} of {clock.of} · {timeLeft(clock.msLeft)} left
        </p>
        <p>
          Squared Away is reading and drafting, but nothing sends during your three days. See if the
          drafts sound like you.
        </p>
        <Link
          href="/billing"
          className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
        >
          See plans
        </Link>
      </section>
    );
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

  switch (status) {
    case "evaluation_expired":
      return inverted(
        "Your three days are up.",
        <>
          Everything here stays as it is, read-only. Nothing new is read or drafted, and nothing is
          sent. To switch sending on, choose a plan — or talk to us first. <Contact />
        </>,
        "Choose a plan",
      );
    case "setup_paid":
      return inverted(
        "Setup's paid. Sending is on.",
        <>
          Every reply still waits for your okay. We&apos;ll call to go through your pricing,
          scheduling and never-promise list. <Contact />
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
          Nothing new is read, drafted or sent, and nothing is deleted. <Contact />
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
