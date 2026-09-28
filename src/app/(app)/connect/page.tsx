import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { bodyRetentionDays } from "@/config/retention";
import { pricing } from "@/config/pricing";
import { requireOwner } from "@/server/session";
import { startGmailConnect } from "./actions";

const errors: Record<string, string> = {
  denied: "No problem — Gmail wasn't connected. You can connect it whenever you're ready.",
  scopes:
    "Google let you untick some permissions, and Squared Away needs all three to work: read, draft, and send. Nothing was saved. Try again and leave them all ticked.",
  expired: "That took a little long and timed out. Tap Connect Gmail to try again.",
  failed: "Something went wrong on the way back from Google. Nothing was saved. Try again.",
};

const words = ["zero", "one", "two", "three", "four", "five"];

export default async function ConnectPage(props: PageProps<"/connect">) {
  await requireOwner();
  const { error } = await props.searchParams;
  const message = typeof error === "string" ? errors[error] : undefined;
  const days = words[pricing.evaluationDays] ?? String(pricing.evaluationDays);

  return (
    <>
      <Headline serif="before you connect," heavy="here's the deal." />

      {message ? <Notice strong>{message}</Notice> : null}

      <section aria-labelledby="will" className="flex flex-col gap-3">
        <h2 id="will" className="text-xl font-black">
          What it will do
        </h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-lg">
          <li>
            Read new email so it can sort it: quotes, questions, scheduling, invoices, complaints,
            suppliers, junk.
          </li>
          <li>Read up to 200 of your sent emails to learn how you write.</li>
          <li>
            Write reply drafts and put them in your Gmail Drafts folder, where you can see them too.
          </li>
          <li>
            Send a reply only when you tap <strong>Send reply</strong>.
          </li>
        </ul>
      </section>

      <section aria-labelledby="wont" className="sa-inverted flex flex-col gap-3 rounded-xl p-5">
        <h2 id="wont" className="text-xl font-black">
          What it won&apos;t do
        </h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-lg">
          <li>
            Send anything without your okay. For your first {days} days, sending is switched off
            completely.
          </li>
          <li>Delete, archive, or move your email.</li>
          <li>
            Share your email. The only outside service that sees it is Anthropic&apos;s AI, to sort
            and draft — and it&apos;s never used to train AI.
          </li>
          <li>Keep the text of your emails longer than {bodyRetentionDays()} days.</li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <p className="text-muted-foreground">
          Google will ask you to allow three things: read, draft, and send. Leave all three ticked.
          While we&apos;re in early access, Google may also say the app isn&apos;t verified yet —
          that&apos;s expected. Tap <strong>Advanced</strong>, then{" "}
          <strong>Go to Squared Away</strong>.
        </p>
        <p className="text-muted-foreground">
          You can disconnect any time in Settings. That also removes our access at Google.
        </p>
        <form action={startGmailConnect}>
          <Button type="submit" size="lg" className="w-full">
            Connect Gmail
          </Button>
        </form>
      </section>
    </>
  );
}
