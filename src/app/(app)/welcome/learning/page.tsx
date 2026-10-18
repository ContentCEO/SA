import type { Metadata } from "next";
import Link from "next/link";
import { AutoRefresh } from "@/components/app/auto-refresh";
import { Headline } from "@/components/brand/headline";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listMailboxes } from "@/server/mailboxes";
import { describeVoice, getVoiceProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import { syncSummary } from "@/server/sync";
import { CLASSIFY_LOOKBACK_DAYS } from "@/server/classification";
import { firstLookCounts } from "@/server/first-week";
import { firstLookLines } from "@/server/first-week-rules";
import { effectiveStatus } from "@/server/lifecycle";
import { TRIAL_NO_SEND_LINE, TRIAL_SIDE_DOOR_LINE } from "@/server/trial-email-rules";

// Check 32 P6: every screen has its own title ("… · Squared Away" from the root template).
export const metadata: Metadata = { title: "Reading your email" };

function Step({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className={cn("flex items-start gap-3 text-lg", done ? "" : "text-muted-foreground")}>
      <span
        aria-hidden
        className={cn(
          "mt-1 inline-block size-4 shrink-0 rounded-full border-2 border-charcoal",
          done && "bg-charcoal",
        )}
      />
      <span>
        <span className="sr-only">{done ? "Done: " : "Working on: "}</span>
        {children}
      </span>
    </li>
  );
}

export default async function WelcomeLearningPage() {
  const { workspace } = await requireOwner();
  const [box] = await listMailboxes(workspace.id);
  const voice = await getVoiceProfile(workspace.id);
  const read = box?.backfillCompletedAt ? (await syncSummary(box.id)).messageCount : 0;
  const voiceDone =
    voice?.status === "ready" || voice?.status === "not_enough_mail" || voice?.status === "failed";
  const allDone = Boolean(box?.backfillCompletedAt) && voiceDone;
  // Round 2 (FW D1): their own inbox, sorted, once reading is done. Counts only.
  const look =
    allDone && box?.backfillCompletedAt
      ? await firstLookCounts(workspace.id, box.backfillCompletedAt)
      : null;
  // Round 2 (FW D4): only promise the email when email is set up.
  const emailsOn = Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
  // The trial's side door (Davi, 2026-10-16), said once the drafts are about to show up.
  const onTrial = effectiveStatus(workspace) === "evaluating";

  return (
    <>
      {!allDone ? <AutoRefresh /> : null}
      <p className="text-sm font-semibold">Step 3 of 3</p>
      <Headline
        serif={allDone ? "all set," : "a few minutes,"}
        heavy={allDone ? "here's how you write." : "reading your email."}
      />

      <ul className="flex flex-col gap-3" aria-live="polite">
        <Step done={Boolean(box?.backfillCompletedAt)}>
          {box?.backfillCompletedAt
            ? `Read ${read.toLocaleString("en-US")} emails from the last 30 days.`
            : "Reading the last 30 days of email…"}
        </Step>
        <Step done={voiceDone}>
          {voice?.status === "ready"
            ? `Learned how you write from ${voice.learnedFromCount} sent emails.`
            : voice?.status === "not_enough_mail"
              ? "Not enough sent mail to learn from yet — drafts will keep it short and plain until there is."
              : voice?.status === "failed"
                ? "Couldn't learn your style this time. We'll try again, and you can set it by hand in Settings."
                : "Reading your sent mail to learn how you write…"}
        </Step>
      </ul>

      {look ? (
        <section aria-labelledby="last-30" className="flex flex-col gap-2">
          <h2 id="last-30" className="text-xl font-black">
            Your last 30 days
          </h2>
          {firstLookLines(look.counts, CLASSIFY_LOOKBACK_DAYS).map((l) => (
            <p key={l} className="text-lg">
              {l}
            </p>
          ))}
        </section>
      ) : null}

      {voice?.status === "ready" ? (
        <section className="flex flex-col gap-3 rounded-xl border-2 border-charcoal bg-card p-5">
          <p className="text-lg">{describeVoice(voice)}</p>
          {voice.phrasesUsed.length ? (
            <p className="text-muted-foreground">
              You say things like “{voice.phrasesUsed.slice(0, 3).join("”, “")}”.
            </p>
          ) : null}
          <Link
            href="/settings/voice"
            className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
          >
            That&apos;s not quite right — fix it
          </Link>
        </section>
      ) : null}

      <p className="text-muted-foreground">
        {allDone
          ? `Nothing gets sent without you. Drafts show up in your queue for you to check.${
              onTrial ? ` ${TRIAL_NO_SEND_LINE} ${TRIAL_SIDE_DOOR_LINE}` : ""
            }`
          : `A busy inbox takes longer: Google has us read it in batches, with pauses. You can leave this screen — it keeps going in the background${
              emailsOn ? ", and we'll email you when your first drafts are ready" : ""
            }.`}
      </p>
      <Link href="/queue" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
        {allDone ? "Go to my queue" : "Go to my queue now"}
      </Link>
    </>
  );
}
