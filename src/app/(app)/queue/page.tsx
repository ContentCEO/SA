import Link from "next/link";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { categoryTag, isCategory } from "@/config/categories";
import { relativeTime } from "@/lib/relative-time";
import { listQueue, sentDraftSummary, type QueueItem } from "@/server/drafts";
import { canSend, isReadOnly, sendingBlockedReason, sendingOffLabel } from "@/server/lifecycle";
import { listMailboxes } from "@/server/mailboxes";
import { requireOwner } from "@/server/session";
import { draftReplyAction } from "./actions";
import { DraftCard } from "./draft-card";

const done: Record<string, string> = {
  discarded: "Draft discarded.",
  saved: "Changes saved. It's updated in Gmail too.",
  drafted: "Reply drafted. It's below, and in your Gmail drafts.",
};
const errors: Record<string, string> = {
  blocked: "Sending isn't switched on for your account, so nothing was sent.",
  changed:
    "That draft was changed in Gmail. Here's the latest version — read it, then tap Send reply again.",
  deleted: "That draft was deleted or sent from Gmail, so it's gone from here too.",
  reconnect: "Google access was lost. Reconnect Gmail in Settings and try again.",
  empty: "The reply was empty, so nothing was sent.",
  exists: "There's already a draft for that one — it's below.",
  replied: "You've already replied to that one.",
  notext: "There's no email text left to reply to (older than 30 days).",
  capped: "Today's drafting limit is used up. It resets tomorrow.",
  draftfailed: "Couldn't write a draft for that one. Try again in a minute.",
  readonly:
    "Your account is read-only right now, so nothing was changed. The note at the top says why.",
  unknown: "That didn't work. Refresh and try again.",
};

const who = (i: QueueItem) => i.customerName || i.customerAddress || "Unknown sender";
const tag = (i: QueueItem) => (isCategory(i.category) ? categoryTag[i.category] : "Email");
const firstName = (name: string | null) => (name ? name.split(/[\s,]+/)[0] : null);

function gmailLink(i: QueueItem) {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(i.mailboxEmail)}#all/${i.gmailThreadId}`;
}

export default async function QueuePage(props: PageProps<"/queue">) {
  const { workspace } = await requireOwner();
  const params = await props.searchParams;
  const [queue, boxes] = await Promise.all([listQueue(workspace.id), listMailboxes(workspace.id)]);
  const sent =
    typeof params.sent === "string" ? await sentDraftSummary(workspace.id, params.sent) : null;
  const doneMsg = typeof params.done === "string" ? done[params.done] : undefined;
  const errorMsg = typeof params.error === "string" ? errors[params.error] : undefined;
  const sending = canSend(workspace);
  const readOnly = isReadOnly(workspace);
  const empty = queue.needsYou.length === 0 && queue.drafts.length === 0;

  return (
    <>
      {sent ? (
        <section
          aria-live="polite"
          className="sa-inverted flex animate-in flex-col gap-3 rounded-xl p-6 duration-500 zoom-in-95 fade-in"
        >
          <p className="flex flex-col">
            <span className="sa-headline-serif text-3xl">reply sent,</span>
            <span className="sa-headline-heavy text-4xl">squared away.</span>
          </p>
          <p className="text-ash">
            {`I'll let you know when ${firstName(sent.toName) ?? "they"} write${firstName(sent.toName) ? "s" : ""} back.`}
          </p>
        </section>
      ) : (
        <Headline serif="waiting on you," heavy="the queue." />
      )}

      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}

      {boxes.length === 0 ? (
        <p className="text-lg">
          Connect Gmail in{" "}
          <Link href="/settings" className="font-semibold underline underline-offset-4">
            Settings
          </Link>{" "}
          to get started.
        </p>
      ) : empty ? (
        <p className="text-2xl font-black">Nothing waiting on you.</p>
      ) : null}

      {queue.needsYou.length ? (
        <section aria-labelledby="needs-you" className="flex flex-col gap-3">
          <h2 id="needs-you" className="text-xl font-black">
            Needs you
          </h2>
          {queue.needsYou.map((i) => (
            <article key={i.threadId} className="sa-inverted flex flex-col gap-2 rounded-xl p-4">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-lg font-black">{who(i)}</span>
                <span className="shrink-0 text-sm text-ash">
                  {i.lastMessageAt ? relativeTime(i.lastMessageAt) : ""}
                </span>
              </div>
              <span className="text-sm font-semibold">{tag(i)}</span>
              {i.needsOwnerReason ? <p className="font-semibold">{i.needsOwnerReason}</p> : null}
              {i.summary ? <p className="text-ash">{i.summary}</p> : null}
              <div className="grid grid-cols-1 gap-2 pt-1">
                {readOnly ? null : (
                  <form action={draftReplyAction}>
                    <input type="hidden" name="threadId" value={i.threadId} />
                    <Button type="submit" className="w-full">
                      Draft a reply
                    </Button>
                  </form>
                )}
                <a
                  href={gmailLink(i)}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex min-h-tap items-center justify-center font-semibold underline underline-offset-4"
                >
                  Open in Gmail
                </a>
              </div>
            </article>
          ))}
        </section>
      ) : null}

      {queue.drafts.length ? (
        <section aria-labelledby="drafts" className="flex flex-col gap-3">
          <h2 id="drafts" className="text-xl font-black">
            Replies ready for you
          </h2>
          {queue.drafts.map((i) => (
            <DraftCard
              key={i.draftId}
              draftId={i.draftId!}
              customer={who(i)}
              tag={tag(i)}
              reason={i.reason ?? ""}
              body={i.body ?? ""}
              flags={i.flags}
              lowConfidence={(i.confidence ?? 0) < 60}
              needsOwnerReason={i.needsOwnerReason}
              canSend={sending}
              readOnly={readOnly}
              sendingOffLabel={sendingOffLabel(workspace)}
              sendingOffDetail={sendingBlockedReason(workspace)}
            />
          ))}
        </section>
      ) : null}
    </>
  );
}
