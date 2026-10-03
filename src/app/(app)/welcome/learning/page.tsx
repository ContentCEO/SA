import Link from "next/link";
import { AutoRefresh } from "@/components/app/auto-refresh";
import { Headline } from "@/components/brand/headline";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { listMailboxes } from "@/server/mailboxes";
import { describeVoice, getVoiceProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import { syncSummary } from "@/server/sync";

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

  return (
    <>
      {!allDone ? <AutoRefresh /> : null}
      <p className="text-sm font-semibold">Step 3 of 3</p>
      <Headline
        serif={allDone ? "all set," : "one minute,"}
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

      {voice?.status === "ready" ? (
        <section className="sa-inverted flex flex-col gap-3 rounded-xl p-5">
          <p className="text-lg">{describeVoice(voice)}</p>
          {voice.phrasesUsed.length ? (
            <p className="text-ash">
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
          ? "Nothing gets sent without you. Drafts show up in your queue for you to check."
          : "You can leave this screen — it keeps going in the background."}
      </p>
      <Link href="/inbox" className={cn(buttonVariants({ size: "lg" }), "w-full")}>
        {allDone ? "Go to my inbox" : "Go to my inbox now"}
      </Link>
    </>
  );
}
