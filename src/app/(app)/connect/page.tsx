import type { Metadata } from "next";
import { dayWord } from "@/lib/trial-words";
import { noticeText } from "@/lib/notice-text";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { bodyRetentionDays } from "@/config/retention";
import { googleAppState, googleWarningLine } from "@/config/google-app";
import { pricing } from "@/config/pricing";
import { siteConfig } from "@/config/site";
import { listMailboxes } from "@/server/mailboxes";
import { requireOwner } from "@/server/session";
import { startGmailConnect, startOutlookConnect } from "./actions";
import { outlookOffered } from "@/config/outlook";

// Check 32 P6: every screen has its own title ("… · Squared Away" from the root template).
// Plan #49: "Connect your email" only while Outlook is offered; off, exactly as before.
export async function generateMetadata(): Promise<Metadata> {
  return { title: outlookOffered() ? "Connect your email" : "Connect Gmail" };
}

const errors: Record<string, string> = {
  busy: "That's a lot in a short time, so we've paused it for a bit. Try again in a few minutes.",
  denied: "No problem — Gmail wasn't connected. You can connect it whenever you're ready.",
  scopes:
    "Google let you untick a permission, and Squared Away needs both to work: “View your email messages and settings” and “Manage drafts and send emails.” Nothing was saved. Try again and leave both ticked.",
  expired: "That took a little long and timed out. Tap Connect Gmail to try again.",
  failed: "Something went wrong on the way back from Google. Nothing was saved. Try again.",
  in_use: `This Gmail is already connected to another Squared Away account. Disconnect it there first, or call Davi at ${siteConfig.phone}.`,
  no_gmail: `This Google account doesn't have Gmail, so there's nothing for Squared Away to read. It works with Gmail and Google Workspace for now. If your business email is on Outlook, call or text Davi at ${siteConfig.phone}; Outlook is on the list.`,
};

/** Plan #49: only reachable while Outlook is offered (the Outlook callback is off otherwise). */
const outlookErrors: Record<string, string> = {
  no_gmail:
    "This Google account doesn't have Gmail, so there's nothing for Squared Away to read. If your business email is on Outlook or Microsoft 365, tap Connect Outlook instead.",
  outlook_denied:
    "No problem — Outlook wasn't connected. You can connect it whenever you're ready.",
  outlook_scopes:
    "Microsoft didn't give Squared Away every permission it needs, so nothing was saved. Try again and allow all of them. If your company's IT manages your Microsoft account, they may need to allow Squared Away first.",
  no_outlook: `This Microsoft account doesn't have an Outlook mailbox Squared Away can reach (some work accounts keep email on the company's own servers). Nothing was saved. Call or text Davi at ${siteConfig.phone} and we'll sort it out.`,
  other_provider:
    "That address is already connected here the other way (Gmail or Outlook). Disconnect it in Settings first if you want to switch.",
};

export default async function ConnectPage(props: PageProps<"/connect">) {
  const { workspace } = await requireOwner();
  const boxes = await listMailboxes(workspace.id);
  const outlook = outlookOffered();
  // Round 2 (FW): setup's honest step count starts here (2: your shop, 3: reading your email).
  const firstConnect = boxes.length === 0;
  const params = await props.searchParams;
  const { error } = params;
  // Check 42 P3: which Gmail this connect is for. Only the workspace's own mailbox ids are
  // read from the URL (never an address); anything else falls back to the plain choice.
  const byId = (v: unknown) => (typeof v === "string" ? boxes.find((b) => b.id === v) : undefined);
  const card =
    byId(params.reconnect) ?? (error === "wrong_account" ? byId(params.mailbox) : undefined);
  const mode: "first" | "add" | "reconnect" = card
    ? "reconnect"
    : params.add === "1" || error === "already_connected"
      ? "add"
      : firstConnect
        ? "first"
        : boxes.length === 1
          ? "reconnect"
          : "add";
  const target = card ?? (mode === "reconnect" ? boxes[0] : undefined);
  const again = error === "already_connected" ? byId(params.mailbox) : undefined;
  const picked = error === "wrong_account" ? byId(params.picked) : undefined;
  const message =
    error === "already_connected" && again
      ? `That's ${again.email} again, which is already connected. Tap Connect another Gmail and pick the other account on Google's screen.`
      : error === "wrong_account" && card
        ? `You picked ${picked ? picked.email : "a different Google account"} but this card is for ${card.email}. Try again and pick ${card.email}.`
        : noticeText(outlook ? { ...errors, ...outlookErrors } : errors, error);
  const days = dayWord(pricing.evaluationDays);
  const googleWarning = googleWarningLine(googleAppState(), siteConfig.name);
  // Plan #49: which button a reconnect belongs to. A card's own provider gets the reconnect;
  // the other button offers a new address (first or another).
  const fresh = firstConnect ? ("first" as const) : ("add" as const);
  const targetIsOutlook = target?.provider === "outlook";
  const gmailMode = targetIsOutlook ? fresh : mode;
  const outlookMode = outlook && targetIsOutlook ? mode : fresh;

  return (
    <>
      {firstConnect ? <p className="text-sm font-semibold">Step 1 of 3</p> : null}
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
            {outlook
              ? "Write reply drafts and put them in your Drafts folder (in Gmail or Outlook), where you can see them too."
              : "Write reply drafts and put them in your Gmail Drafts folder, where you can see them too."}
          </li>
          <li>
            Send a reply only when you tap <strong>Send reply</strong>, or by autopilot if you
            switch it on for a kind of email.
          </li>
        </ul>
      </section>

      <section aria-labelledby="wont" className="sa-inverted flex flex-col gap-3 rounded-xl p-5">
        <h2 id="wont" className="text-xl font-black">
          What it won&apos;t do
        </h2>
        <ul className="flex list-disc flex-col gap-2 pl-5 text-lg">
          <li>
            Send anything without your okay. For your first {days} days, Squared Away won&apos;t
            send anything to a customer: from Squared Away you can only send yourself practice
            copies. Your drafts are in your Gmail Drafts folder too, so you can send one from Gmail
            yourself if you want.
          </li>
          <li>Delete, archive, or move your email.</li>
          <li>
            {/* Check 27 P9: the same places the privacy policy names (our servers, then the AI). */}
            Share your email. It&apos;s stored on our own servers in the US, and the only outside
            company that reads it is Anthropic&apos;s AI, to sort and draft. It&apos;s never used to
            train AI.
          </li>
          <li>Keep the text of your emails longer than {bodyRetentionDays()} days.</li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <p className="text-muted-foreground">
          Google will ask you to allow two things, in its own words:{" "}
          <strong>View your email messages and settings</strong>, and{" "}
          <strong>Manage drafts and send emails</strong>. Leave both ticked. The second one is how a
          reply goes out, and it still goes out only when you tap <strong>Send reply</strong> (or by
          autopilot, if you switch it on for a kind of email).
        </p>
        {/* Check 28 P3: what Google's own screen shows depends on where the app is in Google's
            process (GOOGLE_APP_STATE); nothing once verified. */}
        {googleWarning ? <p className="text-muted-foreground">{googleWarning}</p> : null}
        <p className="text-muted-foreground">
          You can disconnect any time in Settings. That also removes our access at Google.
        </p>
        <form action={startGmailConnect}>
          <input type="hidden" name="mode" value={gmailMode} />
          {target && gmailMode === "reconnect" ? (
            <input type="hidden" name="mailboxId" value={target.id} />
          ) : null}
          <Button type="submit" size="lg" className="w-full">
            {gmailMode === "add"
              ? "Connect another Gmail"
              : gmailMode === "reconnect"
                ? "Reconnect Gmail"
                : "Connect Gmail"}
          </Button>
        </form>
      </section>

      {outlook ? (
        <section aria-labelledby="outlook" className="flex flex-col gap-3">
          <h2 id="outlook" className="text-xl font-black">
            Email on Outlook or Microsoft 365?
          </h2>
          <p className="text-muted-foreground">
            The same promises apply. Microsoft will ask you to allow four things, in its own words:{" "}
            <strong>Read and write access to your mail</strong>, <strong>Send mail as you</strong>,{" "}
            <strong>Maintain access to data you have given it access to</strong>, and{" "}
            <strong>Sign you in and read your profile</strong>. Allow all four. The first is how
            drafts get into your Drafts folder; the second is how a reply goes out, and it still
            goes out only when you tap <strong>Send reply</strong> (or by autopilot, if you switch
            it on for a kind of email); the third lets Squared Away check for new email while
            you&apos;re away; the last tells us your address.
          </p>
          <p className="text-muted-foreground">
            You can disconnect any time in Settings. Microsoft doesn&apos;t let apps remove their
            own access, so we delete our access keys and show you where to remove Squared Away at
            account.microsoft.com.
          </p>
          <form action={startOutlookConnect}>
            <input type="hidden" name="mode" value={outlookMode} />
            {target && outlookMode === "reconnect" ? (
              <input type="hidden" name="mailboxId" value={target.id} />
            ) : null}
            <Button type="submit" size="lg" variant="outline" className="w-full">
              {outlookMode === "add"
                ? "Connect another Outlook"
                : outlookMode === "reconnect"
                  ? "Reconnect Outlook"
                  : "Connect Outlook"}
            </Button>
          </form>
        </section>
      ) : null}
    </>
  );
}
