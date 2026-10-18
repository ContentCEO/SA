import Link from "next/link";
import { daysPhrase } from "@/lib/trial-words";
import { isLastDay } from "@/server/first-week-rules";
import { type Clock, timeLeft } from "@/server/lifecycle";
import { TRIAL_SIDE_DOOR_LINE } from "@/server/trial-email-rules";

/**
 * The trial's banner (StatusBanner, while evaluating). Check 35 P1: it names the clock's own
 * length, so a trial extended in /admin says "your six days" next to "Day 3 of 6".
 */
export function TrialClock({ clock, soFar }: { clock: Clock; soFar: string | null }) {
  const days = daysPhrase(clock.of);
  // Round 2 (FW F2): the last day asks plainly, with what the trial did and a real button.
  if (isLastDay(clock.msLeft)) {
    return (
      <section
        aria-label={`Your ${days}`}
        className="sa-inverted flex flex-col gap-2 rounded-xl p-4"
      >
        <p className="text-lg font-black">
          Your {days} end in {timeLeft(clock.msLeft)}.
        </p>
        {soFar ? <p>{soFar}</p> : null}
        <p className="text-ash">
          Choose a plan to keep it going and to send replies from Squared Away. Every reply still
          waits for your okay. Until then, your drafts are in your Gmail Drafts folder too.
        </p>
        <Link
          href="/billing"
          className="inline-flex min-h-tap items-center justify-center rounded-lg bg-primary px-4 font-semibold text-primary-foreground"
        >
          Choose a plan
        </Link>
      </section>
    );
  }
  return (
    <section
      aria-label={`Your ${days}`}
      className="flex flex-col gap-1 rounded-xl border-2 border-charcoal p-4"
    >
      <p className="text-lg font-black">
        Day {clock.day} of {clock.of} · {timeLeft(clock.msLeft)} left
      </p>
      <p>
        Squared Away is reading and drafting, but it won&apos;t send anything to a customer during
        your {days}. {TRIAL_SIDE_DOOR_LINE}
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
