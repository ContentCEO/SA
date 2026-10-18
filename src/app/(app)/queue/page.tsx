import { randomUUID } from "node:crypto";
import Link from "next/link";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { draftTag } from "@/config/categories";
import { findGaps } from "@/ai/gaps";
import { confidenceLabel } from "@/config/drafting";
import { gmailThreadLink } from "@/lib/gmail-link";
import {
  bodyHash,
  draftGmailLink,
  lateSends,
  listQueue,
  sentDraftSummary,
  type QueueItem,
} from "@/server/drafts";
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
import { senderNameFor } from "@/server/from-line";
import { MAILBOX_PAUSED_LINE } from "@/server/mailbox-plan-rules";
import { dismissChecklistAction } from "./actions";
import { OnboardingChecklist } from "@/components/app/onboarding-checklist";
import { checklistFor } from "@/server/onboarding";
import { DraftCard } from "./draft-card";
import { UndoSend } from "./undo-send";
import { LateSends } from "./late-sends";
import { sendStoppedWhy } from "@/server/activity";
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
import { QUEUE_DONE as done, QUEUE_ERRORS as errors } from "./queue-messages";
import { staleTiming, timingNote } from "@/server/draft-timing";
import { NoteLine } from "@/components/app/note-line";
import { ResortSheet } from "@/components/app/sender-sheets";
import { notesForAddresses, notesForThreads } from "@/server/customer-notes";
import { awayState } from "@/server/away";
import { awayUntilShort } from "@/server/away-rules";
import { offersOtherWays, openingLine } from "@/server/first-contact-rules";
import { turnAwayOffAction } from "../settings/away-actions";

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
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
  const summaries = (
    await Promise.all(sentIds.map((d) => sentDraftSummary(workspace.id, d)))
  ).filter((s) => s !== null);
  // Check 9 P10: a tap that was stopped says so; a late one waits on top with Stop it.
  const stopped = summaries.filter((s) => s.stopped);
  const sentAll = summaries.filter((s) => !s.stopped && !s.late);
  const late = await lateSends(workspace.id);
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
  // Check 43 P3: the name the customer sees in the From line, shown on every card.
  const fromName = await senderNameFor(workspace.id);
  const timeZone = usableTimeZone(
    (await getBusinessProfile(workspace.id))?.timeZone ?? "America/New_York",
  );
  const clock = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone });
  const readOnly = isReadOnly(workspace);
  // Check 42 P1: "This was already answered from Gmail at 2:14pm. Nothing was sent."
  const answeredAt = params.error === "answered" ? Number(params.at) : NaN;
  const answered =
    params.error === "answered"
      ? {
          at: Number.isFinite(answeredAt) && answeredAt > 0 ? new Date(answeredAt) : null,
          href:
            typeof params.d === "string" && /^[0-9a-f-]{36}$/i.test(params.d)
              ? await draftGmailLink(workspace.id, params.d)
              : null,
        }
      : null;
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
    // A Gmail address paused on the plan: shown, but nothing is drafted or changed from it.
    readOnly: readOnly || i.mailboxPaused,
    remindOptions: remindOptions(i),
    gmailHref: gmailLink(i),
    timeZone,
    note: noteFor(i),
    resort: <ResortSheet threadId={i.threadId} current={i.category} back="queue" />,
  });
  // Check 43 P7: "Written Friday. It says “tomorrow”, which meant Saturday. Check the timing."
  const timingNoteFor = (i: QueueItem) => {
    const t = i.draftCreatedAt ? staleTiming(i.body ?? "", i.draftCreatedAt, now, timeZone) : null;
    return t ? timingNote(t) : null;
  };
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

      {stopped.map((s) => (
        <Notice key={s.draftId} strong>
          {s.stopped!.why === "answered_elsewhere"
            ? `Didn't send. Someone had already answered ${firstName(s.toName) ?? "them"} from Gmail, so this reply was set aside.`
            : `Didn't send. ${capitalize(sendStoppedWhy(s.stopped!.why))}, so it's back below to check.`}
        </Notice>
      ))}
      <LateSends items={late} />

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
      {params.error === "autopilot_sent" ? (
        <Notice strong>
          Too late, autopilot already sent it. See it on Activity.
          {typeof params.d === "string" && /^[0-9a-f-]{36}$/i.test(params.d) ? (
            <>
              {" "}
              <Link
                href={`/record/${params.d}`}
                className="inline-flex min-h-tap items-center underline underline-offset-4"
              >
                See record
              </Link>
            </>
          ) : null}
        </Notice>
      ) : null}
      {answered ? (
        <Notice strong>
          This was already answered from Gmail
          {answered.at
            ? ` at ${clock.format(answered.at).replace(/\s?([AP])M$/, (_, m: string) => `${m.toLowerCase()}m`)}`
            : ""}
          . Nothing was sent.
          {answered.href ? (
            <>
              {" "}
              <a
                href={answered.href}
                target="_blank"
                rel="noreferrer"
                className="inline-flex min-h-tap items-center underline underline-offset-4"
              >
                Open the conversation in Gmail
              </a>
            </>
          ) : null}
        </Notice>
      ) : null}

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
              fromName={fromName}
              fromAddress={
                i.fromAddress && i.fromAddress !== i.mailboxEmail.toLowerCase()
                  ? i.fromAddress
                  : null
              }
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
              seenHash={bodyHash(i.body ?? "")}
              timingNote={timingNoteFor(i)}
              flags={i.flags}
              label={confidenceLabel({
                confidencePct: i.confidence,
                flags: i.flags.length,
                gaps: findGaps(i.body ?? "").length,
              })}
              usedFacts={i.usedFacts}
              openingLine={openingLine(i.opening, i.body)}
              otherWays={offersOtherWays({
                opening: i.opening,
                revisionsLeft: i.revisionsLeft,
                // A plan-paused Gmail address: no rewrites either (reviseDraft refuses it too).
                readOnly: readOnly || i.mailboxPaused,
              })}
              revisionsLeft={i.revisionsLeft}
              needsOwnerReason={i.needsOwnerReason}
              canSend={sending && !i.mailboxPaused}
              readOnly={readOnly || i.mailboxPaused}
              autoSendAt={i.autoSendAt ? i.autoSendAt.toISOString() : null}
              autoSendClock={i.autoSendAt ? clock.format(i.autoSendAt) : null}
              sendingOffLabel={i.mailboxPaused ? MAILBOX_PAUSED_LINE : sendingOffLabel(workspace)}
              sendingOffDetail={
                i.mailboxPaused
                  ? "Your plan covers fewer Gmail addresses than you've connected. Pick which one is on in Settings → Your Gmail."
                  : sendingBlockedReason(workspace)
              }
              practiceLeft={i.mailboxPaused ? null : practiceLeft}
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
