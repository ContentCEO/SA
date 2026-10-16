import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { draftTag } from "@/config/categories";
import { findGaps } from "@/ai/gaps";
import { confidenceLabel } from "@/config/drafting";
import { gmailThreadLink } from "@/lib/gmail-link";
import { listQueue, sentDraftSummary, type QueueItem } from "@/server/drafts";
import {
  canPracticeSend,
  canSend,
  isReadOnly,
  PRACTICE_SEND_LIMIT,
  sendingBlockedReason,
  sendingOffLabel,
} from "@/server/lifecycle";
import { practiceSendsUsed } from "@/server/practice";
import { listMailboxes } from "@/server/mailboxes";
import { getBusinessProfile } from "@/server/profile";
import { priceMemoryFor } from "@/server/price-memory";
import { requireOwner } from "@/server/session";
import { dismissChecklistAction } from "./actions";
import { OnboardingChecklist } from "@/components/app/onboarding-checklist";
import { checklistFor } from "@/server/onboarding";
import { DraftCard } from "./draft-card";
import { UndoSend } from "./undo-send";
import { OfflineQueue } from "./offline-queue";
import { devicePrefs } from "@/lib/device-prefs";
import { ScrollToThread } from "./scroll-to-thread";
import { SNOOZE_LABELS, snoozeOptions, usableTimeZone } from "@/server/snooze-rules";
import { batchCandidates } from "@/server/drafts";
import { BATCH_CATEGORIES } from "@/server/batch-rules";
import { Button, buttonVariants } from "@/components/ui/button";
import { firstLookFor } from "@/server/first-week";
import { wroteLine } from "@/server/first-week-rules";
import { NeedsYouCard } from "./needs-you-card";
import { leadCardsFor } from "@/server/lead-cards";
import { notAnsweredRows } from "@/server/never-answered";
import { NotAnsweredCard } from "./not-answered-card";
import { FirstLookCard } from "./first-look";
import { CONTROL_DONE, CONTROL_ERRORS } from "@/config/control-messages";
import { NoteLine } from "@/components/app/note-line";
import { ResortSheet } from "@/components/app/sender-sheets";
import { notesForAddresses, notesForThreads } from "@/server/customer-notes";
import { awayState } from "@/server/away";
import { awayUntilShort } from "@/server/away-rules";
import { turnAwayOffAction } from "../settings/away-actions";

const done: Record<string, string> = {
  ...CONTROL_DONE,
  away_off: "Welcome back. Away mode is off.",
  discarded: "Draft discarded.",
  saved: "Changes saved. It's updated in Gmail too.",
  drafted: "Reply drafted. It's below, and in your Gmail drafts.",
  revised: "Draft changed. Read it below — it's updated in Gmail too.",
  practice:
    "Practice copy sent to your own inbox — your customer got nothing. The draft is still below.",
  undone: "Stopped. Nothing was sent — it's back below.",
  snoozed: "Snoozed. It'll come back to the top of the queue.",
  held: "Held. It won't send until you tap Send reply.",
  called:
    "Marked as answered by phone. No draft and no nudge for that one unless they write again.",
  done: "Marked done. It'll come back if they write again.",
  fixed: "Marked fixed. I'll remind you to check in with them in 2 days.",
  checkin_closed: "Good. That one's closed.",
  town_added: "Town added to your list. Draft a reply when you're ready.",
  found_money:
    "Writing those drafts now. They show up below in a minute or two, and each one waits for you.",
};
const errors: Record<string, string> = {
  ...CONTROL_ERRORS,
  gaps: "Fill in every gap before sending (anything like {{price}} or [price]) — nothing was sent.",
  busy: "That's a lot in a short time, so we've paused it for a bit. Try again in a few minutes.",
  blocked: "Sending isn't switched on for your account, so nothing was sent.",
  changed:
    "That draft was changed in Gmail. Here's the latest version — read it, then tap Send reply again.",
  deleted: "That draft was deleted or sent from Gmail, so it's gone from here too.",
  to_changed:
    "Who that reply goes to changed since you opened it, so nothing was sent. Check the To line, then tap Send reply again.",
  reconnect: "Google access was lost. Reconnect Gmail in Settings and try again.",
  empty: "The reply was empty, so nothing was sent.",
  exists: "There's already a draft for that one — it's below.",
  replied: "You've already replied to that one.",
  notext: "There's no email text left to reply to (older than 30 days).",
  capped: "Today's drafting limit is used up. It resets tomorrow.",
  revisions: "That draft has been changed as many times as it can be. Edit it by hand instead.",
  practice_limit: "That's all 10 practice sends. The real thing turns on once setup is paid.",
  toolate: "Too late to undo — that reply has already gone.",
  gone: "That draft isn't waiting any more, so nothing was sent.",
  snooze: "That can't be put off that long — it looks urgent. Pick an earlier time.",
  draftfailed: "Couldn't write a draft for that one. Try again in a minute.",
  gmail_busy: "Gmail asked us to slow down. Try again in a minute.",
  reply_to_unread: "We couldn't check who this goes to. Try again in a minute.",
  no_reply_address:
    "That one would go to a no-reply address — answer them on the platform or by phone.",
  textaddr:
    "That address turns email into a text message, and Squared Away never texts customers. Use Text from my phone instead.",
  leadsite: "That one came through a lead website — answer them on the website.",
  phonemsg: "That's a voicemail or text message — call or text them back from your phone.",
  readonly:
    "Your account is read-only right now, so nothing was changed. The note at the top says why.",
  // Deposit / review / closing notes (plan #26 #28 #29).
  purpose_not_allowed: "That one isn't ready for that kind of note.",
  not_eligible: "That one isn't ready for that kind of note.",
  feature_off: "That isn't switched on for your account yet.",
  already_asked: "You've already asked them once.",
  no_review_link: "Add your review link in Settings → Business profile first.",
  review_recent: "You asked them for a review in the last 12 months.",
  complaint: "Not for a complaint — reply to that one yourself.",
  has_draft: "Send or discard the reply first.",
  unknown: "That didn't work. Refresh and try again.",
};

const who = (i: QueueItem) => i.customerName || i.customerAddress || "Unknown sender";
const tag = (i: QueueItem) => draftTag(i);

/**
 * The one line under "squared away." — what happens next, honestly. The day is the owner's own
 * (round 2, FW C10: their time zone, not always Eastern).
 */
function nextLine(
  sent: NonNullable<Awaited<ReturnType<typeof sentDraftSummary>>>,
  timeZone: string,
) {
  const name = firstName(sent.toName);
  if (sent.nudgeOn) {
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone });
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
    checklistFor(workspace.id, { readOnly: isReadOnly(workspace) }),
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
  const timeZone = usableTimeZone(
    (await getBusinessProfile(workspace.id))?.timeZone ?? "America/New_York",
  );
  const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const readOnly = isReadOnly(workspace);
  const firstLook = await firstLookFor(workspace);
  const empty = queue.needsYou.length === 0 && queue.drafts.length === 0;
  const now = new Date();
  // Plan #40: practice sends only exist during the three days.
  const practiceLeft = canPracticeSend(workspace, now)
    ? Math.max(0, PRACTICE_SEND_LIMIT - (await practiceSendsUsed(workspace.id)))
    : null;
  const device = await devicePrefs();
  const remindOptions = (i: QueueItem) =>
    snoozeOptions(now, timeZone, i.emergency).map((o) => ({
      choice: o.choice,
      label: SNOOZE_LABELS[o.choice],
    }));
  const readyCount =
    sending && !readOnly ? (await batchCandidates(workspace.id, BATCH_CATEGORIES)).length : 0;
  // Plan #15: the owner's own past prices for similar jobs, on quote-request drafts only.
  // Shown here and tapped in by the owner — never sent to the drafter.
  const priceMemory = await priceMemoryFor(
    workspace.id,
    queue.drafts.filter((i) => i.category === "quote_request").map((i) => i.threadId),
    { timeZone, now },
  );

  // Ideas G7: private notes. Drafts are keyed on where the reply goes; needs-you items on the
  // customer's newest email. Never in queue counts (those come from queueMembership).
  const allThreadIds = [...queue.needsYou, ...queue.drafts].map((i) => i.threadId);
  const [threadNotes, draftNotes, away] = await Promise.all([
    notesForThreads(workspace.id, allThreadIds),
    notesForAddresses(
      workspace.id,
      queue.drafts.map((i) => i.toAddress),
    ),
    awayState(workspace.id, now),
  ]);
  // A phone that keeps a copy of the queue (offline okays) never holds a note's text.
  const noteFor = (i: QueueItem) => (
    <NoteLine
      note={
        i.draftId
          ? draftNotes.get((i.toAddress ?? "").trim().toLowerCase())
          : threadNotes.get(i.threadId)?.note
      }
      editKey={threadNotes.get(i.threadId)?.key}
      hidden={device.offline}
    />
  );

  // Leads package: Call / Text, the emergency lane, lead-site and voicemail cards, the
  // repeat-customer and outside-your-area lines — read in a fixed number of queries.
  // B6: customers who have waited over a day with no card here (one row each, oldest first).
  const notAnswered = await notAnsweredRows(
    workspace.id,
    now,
    new Set([...queue.needsYou, ...queue.drafts].map((i) => i.threadId)),
  );
  const leadCards = await leadCardsFor(
    workspace.id,
    [
      ...queue.needsYou.map((i) => ({ ...i, needsYou: true })),
      ...queue.drafts.map((i) => ({ ...i, needsYou: false })),
      ...notAnswered.map((r) => ({ ...r, leadChannel: null, needsYou: true })),
    ],
    { now, timeZone, businessName: workspace.businessName },
  );
  // The lane comes from the queue's own membership, like the counts (B5).
  const lane = queue.needsYou.filter((i) => i.lane);
  const needsYou = queue.needsYou.filter((i) => !i.lane);
  const needsYouProps = (i: QueueItem) => ({
    i,
    lead: leadCards.get(i.threadId),
    who: who(i),
    tag: tag(i),
    readOnly,
    remindOptions: remindOptions(i),
    gmailHref: gmailLink(i),
    timeZone,
    note: noteFor(i),
    resort: <ResortSheet threadId={i.threadId} current={i.category} back="queue" />,
  });
  const draftLeadLines = (i: QueueItem) => {
    const lc = leadCards.get(i.threadId);
    return [
      lc?.repeat,
      lc?.outsideTown ? `${lc.outsideTown} isn't one of your towns.` : null,
    ].filter((l): l is string => !!l);
  };

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
            </span>{" "}
            <span className="sa-headline-heavy text-4xl">squared away.</span>
          </p>
          {sent ? <p className="text-ash">{nextLine(sent, timeZone)}</p> : null}
          {sent && !sent.sendingAt ? (
            <Link
              href={`/record/${sent.draftId}`}
              className="inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
            >
              See record
            </Link>
          ) : null}
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

      {away.on && away.backOn ? (
        <form
          action={turnAwayOffAction}
          className="flex flex-col gap-2 rounded-xl border-2 border-charcoal p-4"
        >
          <input type="hidden" name="back" value="queue" />
          <p className="font-semibold">
            Away mode is on until {awayUntilShort(away.backOn)}. Follow-ups are paused.
          </p>
          <Button type="submit" variant="outline" className="w-full">
            Turn off away mode
          </Button>
        </form>
      ) : null}
      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}

      <OfflineQueue enabled={device.offline} />
      {/* A fresh key per server render: a later navigation or action remounts it, so a
          "not on your queue" notice from an earlier link doesn't linger (finding M8-7). */}
      <ScrollToThread key={randomUUID()} />

      {boxes.length === 0 ? (
        // Round 2 (FW): a first-timer's one big next step, before the checklist.
        <section aria-labelledby="start" className="flex flex-col gap-3">
          <h2 id="start" className="text-xl font-black">
            Start here
          </h2>
          <p className="text-lg">
            Connect the Gmail you run the business from. We show you what Squared Away can and
            can&apos;t do before Google asks.
          </p>
          <Link href="/connect" className={buttonVariants({ size: "lg", className: "w-full" })}>
            Connect Gmail
          </Link>
        </section>
      ) : null}

      <OnboardingChecklist list={checklist} dismissAction={dismissChecklistAction} />

      {boxes.length === 0 ? null : empty && notAnswered.length === 0 ? (
        <p className="text-2xl font-black">Nothing waiting on you.</p>
      ) : null}

      {lane.length ? (
        <section aria-labelledby="emergency" className="flex flex-col gap-3">
          <h2 id="emergency" className="text-xl font-black">
            Emergency
          </h2>
          {lane.map((i) => (
            <NeedsYouCard key={i.threadId} {...needsYouProps(i)} />
          ))}
        </section>
      ) : null}

      {needsYou.length ? (
        <section aria-labelledby="needs-you" className="flex flex-col gap-3">
          <h2 id="needs-you" className="text-xl font-black">
            Needs you
          </h2>
          {needsYou.map((i) => (
            <NeedsYouCard key={i.threadId} {...needsYouProps(i)} />
          ))}
        </section>
      ) : null}

      {notAnswered.length ? (
        <section aria-labelledby="not-answered" className="flex flex-col gap-3">
          <h2 id="not-answered" className="text-xl font-black">
            Not answered yet
          </h2>
          <p>They wrote over a day ago and haven&apos;t heard back.</p>
          {notAnswered.map((r) => (
            <NotAnsweredCard
              key={r.threadId}
              row={r}
              lead={leadCards.get(r.threadId)}
              now={now}
              readOnly={readOnly}
            />
          ))}
        </section>
      ) : null}

      {/* After what needs them now: the first week's look back (round 2, FW D1/D2). */}
      <FirstLookCard look={firstLook} readOnly={readOnly} />

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
              toAddress={i.toAddress ?? ""}
              toFromReplyTo={i.replyRedirected && i.toAddress === i.customerAddress}
              tag={`${i.backFromSnooze ? "Back from snooze · " : ""}${tag(i)}`}
              wrote={wroteLine(i.customerWroteAt, now)}
              leadLines={draftLeadLines(i)}
              threadId={i.threadId}
              leftHanded={device.leftHanded}
              offlineEnabled={device.offline}
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
              practiceLeft={practiceLeft}
              priceMemory={priceMemory.get(i.threadId)}
              noteLine={noteFor(i)}
              moreActions={
                <ResortSheet threadId={i.threadId} current={i.category} hasReply back="queue" />
              }
            />
          ))}
        </section>
      ) : null}
    </>
  );
}
