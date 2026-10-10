import Link from "next/link";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";
import { categoryTag, isCategory } from "@/config/categories";
import { findGaps } from "@/ai/gaps";
import { confidenceLabel } from "@/config/drafting";
import { gmailThreadLink } from "@/lib/gmail-link";
import { relativeTime } from "@/lib/relative-time";
import { listQueue, sentDraftSummary, type QueueItem } from "@/server/drafts";
import { canSend, isReadOnly, sendingBlockedReason, sendingOffLabel } from "@/server/lifecycle";
import { listMailboxes } from "@/server/mailboxes";
import { getBusinessProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import { dismissChecklistAction, draftReplyAction } from "./actions";
import { OnboardingChecklist } from "@/components/app/onboarding-checklist";
import { checklistFor } from "@/server/onboarding";
import { DraftCard } from "./draft-card";
import { UndoSend } from "./undo-send";
import { RemindMe } from "./remind-me";
import { SNOOZE_LABELS, snoozeOptions } from "@/server/snooze-rules";
import { batchCandidates } from "@/server/drafts";
import { BATCH_CATEGORIES } from "@/server/batch-rules";

const done: Record<string, string> = {
  discarded: "Draft discarded.",
  saved: "Changes saved. It's updated in Gmail too.",
  drafted: "Reply drafted. It's below, and in your Gmail drafts.",
  revised: "Draft changed. Read it below — it's updated in Gmail too.",
  undone: "Stopped. Nothing was sent — it's back below.",
  snoozed: "Snoozed. It'll come back to the top of the queue.",
  held: "Held. It won't send until you tap Send reply.",
};
const errors: Record<string, string> = {
  gaps: "Fill in every highlighted gap before sending — nothing was sent.",
  busy: "That's a lot in a short time, so we've paused it for a bit. Try again in a few minutes.",
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
  revisions: "That draft has been changed as many times as it can be. Edit it by hand instead.",
  toolate: "Too late to undo — that reply has already gone.",
  snooze: "That can't be put off that long — it looks urgent. Pick an earlier time.",
  draftfailed: "Couldn't write a draft for that one. Try again in a minute.",
  readonly:
    "Your account is read-only right now, so nothing was changed. The note at the top says why.",
  unknown: "That didn't work. Refresh and try again.",
};

const who = (i: QueueItem) => i.customerName || i.customerAddress || "Unknown sender";
const tag = (i: QueueItem) => {
  const category = isCategory(i.category) ? categoryTag[i.category] : "Email";
  return i.kind === "followup" ? `Follow-up · ${category}` : category;
};

const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "America/New_York" });

/** The one line under "squared away." — what happens next, honestly. */
function nextLine(sent: NonNullable<Awaited<ReturnType<typeof sentDraftSummary>>>) {
  const name = firstName(sent.toName);
  if (sent.nudgeOn) {
    return `I'll nudge ${name ?? "them"} on ${weekday.format(sent.nudgeOn)} if there's no reply.`;
  }
  if (sent.lastNudgeUsed) return "That was the last nudge. I won't chase this one again.";
  return `I'll let you know when ${name ?? "they"} write${name ? "s" : ""} back.`;
}
const firstName = (name: string | null) => (name ? name.split(/[\s,]+/)[0] : null);

const gmailLink = (i: QueueItem) => gmailThreadLink(i);

export default async function QueuePage(props: PageProps<"/queue">) {
  const { workspace } = await requireOwner();
  const params = await props.searchParams;
  const [queue, boxes, checklist] = await Promise.all([
    listQueue(workspace.id),
    listMailboxes(workspace.id),
    checklistFor(workspace.id),
  ]);
  // One id after a tap, several after "Send N replies" (plan #5).
  const sentIds = (Array.isArray(params.sent) ? params.sent : params.sent ? [params.sent] : [])
    .filter((s) => /^[0-9a-f-]{36}$/i.test(s))
    .slice(0, 50);
  const sentAll = (await Promise.all(sentIds.map((d) => sentDraftSummary(workspace.id, d)))).filter(
    (s) => s !== null,
  );
  const sent = sentAll.length === 1 ? sentAll[0]! : null;
  const sendingIds = sentAll.filter((s) => s.sendingAt).map((s) => s.draftId);
  const sendAt = sentAll
    .map((s) => s.sendingAt)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => b.getTime() - a.getTime())[0];
  const refused = Number(params.refused) || 0;
  const doneMsg = typeof params.done === "string" ? done[params.done] : undefined;
  const errorMsg = typeof params.error === "string" ? errors[params.error] : undefined;
  const sending = canSend(workspace);
  const timeZone = (await getBusinessProfile(workspace.id))?.timeZone ?? "America/New_York";
  const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const readOnly = isReadOnly(workspace);
  const empty = queue.needsYou.length === 0 && queue.drafts.length === 0;
  const now = new Date();
  const remindOptions = (i: QueueItem) =>
    snoozeOptions(now, timeZone, i.emergency).map((o) => ({
      choice: o.choice,
      label: SNOOZE_LABELS[o.choice],
    }));
  const readyCount =
    sending && !readOnly ? (await batchCandidates(workspace.id, BATCH_CATEGORIES)).length : 0;

  return (
    <>
      {sentAll.length ? (
        <section
          aria-live="polite"
          className="sa-inverted flex animate-in flex-col gap-3 rounded-xl p-6 duration-500 zoom-in-95 fade-in"
        >
          <p className="flex flex-col">
            <span className="sa-headline-serif text-3xl">
              {sentAll.length > 1
                ? `${sentAll.length} replies ${sendingIds.length ? "on their way" : "sent"},`
                : sendingIds.length
                  ? "reply on its way,"
                  : "reply sent,"}
            </span>
            <span className="sa-headline-heavy text-4xl">squared away.</span>
          </p>
          {sent ? <p className="text-ash">{nextLine(sent)}</p> : null}
          {refused ? (
            <p className="text-ash">
              {refused} {refused === 1 ? "reply wasn't" : "replies weren't"} sent — they changed or
              need a closer look, so they&apos;re still below.
            </p>
          ) : null}
          {sendingIds.length && sendAt ? (
            <UndoSend key={sendingIds.join()} draftIds={sendingIds} sendAt={sendAt.toISOString()} />
          ) : null}
        </section>
      ) : (
        <Headline serif="waiting on you," heavy="the queue." />
      )}

      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}

      <OnboardingChecklist list={checklist} dismissAction={dismissChecklistAction} />

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
              <span className="text-sm font-semibold">
                {i.backFromSnooze ? "Back from snooze · " : ""}
                {tag(i)}
              </span>
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
                <RemindMe threadId={i.threadId} options={remindOptions(i)} inverted />
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
          {readyCount >= 2 ? (
            <Link
              href="/queue/review"
              className="inline-flex min-h-tap items-center justify-center rounded-lg border-2 border-charcoal px-4 font-black"
            >
              Review all {readyCount} ready
            </Link>
          ) : null}
          {queue.drafts.map((i) => (
            <DraftCard
              // Remount when the text changes (e.g. edited in Gmail) so filled gaps reset to it.
              key={`${i.draftId}:${i.body}`}
              draftId={i.draftId!}
              customer={who(i)}
              tag={`${i.backFromSnooze ? "Back from snooze · " : ""}${tag(i)}`}
              threadId={i.threadId}
              remindOptions={remindOptions(i)}
              summary={i.summary}
              reason={i.reason ?? ""}
              body={i.body ?? ""}
              flags={i.flags}
              label={confidenceLabel({
                confidencePct: i.confidence,
                flags: i.flags.length,
                gaps: findGaps(i.body ?? "").length,
              })}
              usedFacts={i.usedFacts}
              revisionsLeft={i.revisionsLeft}
              needsOwnerReason={i.needsOwnerReason}
              canSend={sending}
              readOnly={readOnly}
              autoSendAt={i.autoSendAt ? clock.format(i.autoSendAt) : null}
              sendingOffLabel={sendingOffLabel(workspace)}
              sendingOffDetail={sendingBlockedReason(workspace)}
            />
          ))}
        </section>
      ) : null}
    </>
  );
}
