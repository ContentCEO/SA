"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { CustomerName } from "@/components/app/customer-name";
import { useFormStatus } from "react-dom";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SIGNATURE_FIELD_HREF } from "@/server/from-line-rules";
import { fillGap, findGaps } from "@/ai/gaps";
import type { ConfidenceLabel } from "@/config/drafting";
import {
  BodyWithGaps,
  ConfidenceTag,
  PastPrices,
  WhyThis,
  type GapOpen,
  type PastPrice,
} from "./draft-parts";
import { OtherWaysToReply, SayAChange, TweakChips } from "./revise-controls";
import { RemindMe, type SnoozeOption } from "./remind-me";
import { CalledThem } from "./called-them";
import { AutopilotCountdown } from "./autopilot-countdown";
import { DraftEditor, keptEditKey } from "./draft-editor";
import { SendButton } from "./send-button";
import { CardTargets, closeOnEscape, QuestionLine, useFocusReturn } from "./focus";
import { DiscardCountdown, SwipeLabel, SwipeTip } from "./swipe-parts";
import { readKept } from "@/lib/kept-text";
import { withoutCategoryPrefix } from "@/lib/card-words";
import {
  addIntent,
  intentsServerSnapshot,
  intentsSnapshot,
  removeIntent,
  sha256Hex,
  subscribeIntents,
} from "@/lib/offline-intents";
import {
  discardDraftAction,
  holdAutopilotAction,
  nudgeAlreadyPaidAction,
  nudgeSaidNoAction,
  practiceSendAction,
  sendDraftAction,
} from "./actions";

export type DraftCardProps = {
  draftId: string;
  threadId: string;
  /** Check 9 P5: the card after this one, where a send, discard or snooze lands. */
  nextThreadId?: string | null;
  /** Check 9 P5: the done / error notice for a tap on this card, shown at its top. */
  notice?: React.ReactNode;
  /** Plan #6: the "Remind me" times allowed for this one right now. */
  remindOptions?: SnoozeOption[];
  customer: string;
  /** Check 13 P9: the customer page key; the name links there when set. */
  customerKey?: string | null;
  /** H7: the address this reply goes to, shown on the card and above the editor. */
  toAddress: string;
  /** The customer's email named this address to reply to (a website form's Reply-To). */
  toFromReplyTo?: boolean;
  /** Check 43 P3: the name the customer sees in the From line ("Mike Rossi"). */
  fromName?: string | null;
  /** Check 42 P4: the send-as alias it goes out from, only when not the connected address. */
  fromAddress?: string | null;
  /** Check 43 P5: the subject the customer sees ("Your request to Rossi Plumbing"). */
  subject?: string | null;
  /** Check 43 P4: "No signature…" under the reply (the queue's first card, signature empty). */
  noSignatureLine?: string | null;
  tag: string;
  /** Round 2 (FW E9): when the customer wrote ("Wrote 9 days ago"), on every card. */
  wrote?: string | null;
  /** Leads package (B14 / B9): one-liners from code ("Repeat customer: …"). */
  leadLines?: string[];
  /** Replies package: "First reply: asks 2 questions · …" on a first reply to a new lead. */
  openingLine?: string | null;
  /** Replies package: show "Other ways to reply" (a first reply that can still be changed). */
  otherWays?: boolean;
  /** One line on what the customer wants, from sorting — so the card reads without opening Gmail. */
  summary?: string | null;
  reason: string;
  body: string;
  /** Check 9 P1: the fingerprint of `body`, posted with Send reply so a changed draft waits. */
  seenHash: string;
  /**
   * Check 43 P7: the draft's time words may be out of date ("Written Friday. It says
   * “tomorrow”…"). Send reply becomes "Send reply anyway", which confirms it.
   */
  timingNote?: string | null;
  /** Check 43 P8: "They wrote in Spanish. Reply in Spanish." (only when not English). */
  languageLine?: string | null;
  flags: string[];
  /** Plan #8: Ready / Check the details / Check everything. */
  label: ConfidenceLabel;
  /** Plan #1: profile facts and voice traits the drafter used (keys). */
  usedFacts: string[];
  /** Plan #10: this phone keeps okays given with no signal (opt-in). */
  offlineEnabled?: boolean;
  /** Plan #9: mirror the swipes and the button order for a left thumb. */
  leftHanded?: boolean;
  /**
   * Check 21 P8: a nudge (follow-up) card — Discard says it ends the chasing, and one more row
   * offers "They said no" (a quote) or "Already paid" (an invoice).
   */
  nudge?: "quote" | "invoice" | "other" | null;
  /** Check 9 P14: the one-time swipe tip (first draft card only; touch phones only). */
  swipeTip?: boolean;
  /** Quick tweaks / voice edits left (0 hides them). */
  revisionsLeft?: number;
  needsOwnerReason: string | null;
  /**
   * Check 9 P12: the card sits under "Right now", which already says it needs the owner — so
   * "Needs you: …" shows only when there's no summary to say what it's about.
   */
  inRightNow?: boolean;
  canSend: boolean;
  /** Read-only account: show the draft, but no edit, discard or swipe. */
  readOnly?: boolean;
  /** Autopilot will send this at this time (ISO) unless held (Check 9 P2: a live countdown). */
  autoSendAt?: string | null;
  /** The same time as a clock ("9:42 AM"), in the owner's time zone. */
  autoSendClock?: string | null;
  /** Check 20 P7: "Autopilot is on for scheduling, but this one waits: …" (null = say nothing). */
  autopilotWait?: string | null;
  sendingOffLabel: string;
  sendingOffDetail: string;
  /** Plan #40: practice sends left during the three days; null outside them. */
  practiceLeft?: number | null;
  /**
   * Plan #15: what the owner quoted for similar jobs (quote requests only). Owner-only:
   * a figure reaches the draft only when they tap it into a {{price}} gap.
   */
  priceMemory?: PastPrice[];
  /** Ideas G7: the owner's private note line (rendered by the server page). */
  noteLine?: React.ReactNode;
  /** Check 37 P2: the permit card (and the town caution), rendered by the page. */
  permitCard?: React.ReactNode;
  /** Ideas H4: "Wrong kind?" (rendered by the server page). */
  moreActions?: React.ReactNode;
};

function Pending({
  label,
  busy,
  ...props
}: { label: string; busy: string } & React.ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} {...props}>
      {pending ? busy : label}
    </Button>
  );
}

/**
 * H7: who the reply goes to, as visible text (never an aria-label: Sentry's ui.* scrub isn't
 * relied on), so the owner can catch a wrong address before tapping Send reply.
 */
function ToLine({
  address,
  fromReplyTo,
  fromName,
  fromAddress,
}: {
  address: string;
  fromReplyTo?: boolean;
  fromName?: string | null;
  fromAddress?: string | null;
}) {
  const from = [fromName, fromAddress].filter(Boolean).join(" · ");
  return (
    // Check 8 P9: 16px — read in the sun before Send reply.
    <p className="text-base break-all">
      {/* Check 43 P3: what the customer will see as the sender. */}
      {from ? (
        <span className="block">
          <span className="font-semibold">From:</span> {from}
        </span>
      ) : null}
      <span className="font-semibold">To:</span> {address}
      {fromReplyTo ? (
        <span className="block text-muted-foreground">the reply address in their email</span>
      ) : null}
    </p>
  );
}

const SWIPE_REVEAL = 90;
const DISCARD_UNDO_SECONDS = 5;

/** A short tap of the motor where the phone has one; nothing where it doesn't. */
const buzz = () => {
  try {
    navigator.vibrate?.(12);
  } catch {
    // Not available (iPhone Safari, desktops): no buzz.
  }
};

/**
 * One draft in the queue. On a phone (plan #9), swipe toward the thumb side to
 * open it for sending — the full text and the Send button, never a send — and
 * the other way to discard, with a few seconds to undo. Mirrored for a left
 * thumb. Send reply is always a deliberate tap.
 */
export function DraftCard(p: DraftCardProps) {
  const [editing, setEditing] = useState(false);
  // Check 8 P1 / 9 P4: text typed in Edit before a reload or a failed save, kept in this tab.
  const [kept, setKept] = useState<string | null>(null);
  useEffect(() => {
    const k = readKept(keptEditKey(p.draftId), p.seenHash);
    if (k === null) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the browser after mount
    setKept(k);
    setEditing(true);
  }, [p.draftId, p.seenHash]);
  const [expanded, setExpanded] = useState(false);
  // Outside review (2026-10-15): the quick changes live behind one button, so Send reply
  // stays on the first screen of a card.
  const [changing, setChanging] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  // Check 32 P1: closing a question (Keep it, Cancel, Escape) puts focus back on its opener.
  const { opener: discardOpener, restore: restoreDiscardFocus } = useFocusReturn();
  const { opener: editOpener, restore: restoreEditFocus } = useFocusReturn();
  const discardTitle = useId();
  const keepDraft = () => {
    restoreDiscardFocus();
    setConfirmDiscard(false);
  };
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const buzzed = useRef(false);
  const sendArea = useRef<HTMLDivElement>(null);
  const discardForm = useRef<HTMLFormElement>(null);
  const [discardIn, setDiscardIn] = useState<number | null>(null);
  // Plan #10: an okay this phone is holding until it's back online.
  const intents = useSyncExternalStore(subscribeIntents, intentsSnapshot, intentsServerSnapshot);
  const waitingForSignal = intents.includes(`"draftId":"${p.draftId}"`);
  const okayOffline = (e: React.FormEvent<HTMLFormElement>) => {
    if (!p.offlineEnabled || navigator.onLine) return;
    e.preventDefault();
    const shown = p.body;
    void sha256Hex(shown).then((seen) =>
      addIntent({
        draftId: p.draftId,
        seen,
        body: body !== shown ? body : undefined,
        at: Date.now(),
        to: p.customer.split(/[\s,@]+/)[0] || "them",
        seenTo: p.toAddress,
      }),
    );
  };
  const canChange = !p.readOnly && (p.revisionsLeft ?? 0) > 0;
  // Right thumb: right opens for sending. Left thumb: mirrored.
  const toSend = p.leftHanded ? -1 : 1;

  useEffect(() => {
    if (discardIn === null) return;
    if (discardIn === 0) {
      discardForm.current?.requestSubmit();
      return;
    }
    const t = setTimeout(() => setDiscardIn((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(t);
  }, [discardIn]);
  // The body as the owner sees it — gaps they fill in change it before sending.
  const [body, setBody] = useState(p.body);
  const gapsLeft = findGaps(body).length;
  // Check 9 P11: the open gap's fill box lives here, so the "Fill in N gaps" button opens it.
  const [openGap, setOpenGap] = useState<GapOpen>(null);
  const bodyBox = useRef<HTMLDivElement>(null);
  const openFirstGap = () => {
    setOpenGap({ index: 0, body });
    requestAnimationFrame(() =>
      bodyBox.current?.querySelector("form")?.scrollIntoView({ block: "center" }),
    );
  };
  const priceGap = findGaps(body).findIndex((g) => g.kind === "price");
  // Only ever on the owner's tap, and only into a {{price}} gap.
  const usePrice = (value: string) => {
    if (priceGap >= 0) setBody(fillGap(body, priceGap, value));
  };
  const pastPrices = p.priceMemory ?? [];
  // Check 23 P8: a quick change keeps the gaps filled on the card (sent only when changed).
  const cardBody = body !== p.body ? body : undefined;

  const onPointerDown = (e: React.PointerEvent) => {
    if (editing || p.readOnly || e.pointerType === "mouse") return;
    start.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const x = e.clientX - start.current.x;
    const y = e.clientY - start.current.y;
    if (Math.abs(y) > Math.abs(x)) return; // scrolling, not swiping
    const next = Math.min(140, Math.max(-140, x));
    if (Math.abs(next) >= SWIPE_REVEAL && !buzzed.current) {
      buzzed.current = true;
      buzz();
    }
    setDx(next);
  };
  const onPointerUp = () => {
    if (dx * toSend >= SWIPE_REVEAL) {
      // Open for sending: the whole draft and the Send button, ready for a deliberate tap.
      setExpanded(true);
      setConfirmDiscard(false);
      requestAnimationFrame(() => {
        sendArea.current?.scrollIntoView({ block: "center" });
        sendArea.current?.querySelector<HTMLElement>("button, [role=note]")?.focus();
      });
    } else if (dx * toSend <= -SWIPE_REVEAL) {
      setDiscardIn(DISCARD_UNDO_SECONDS);
    }
    setDx(0);
    buzzed.current = false;
    start.current = null;
  };

  return (
    // Check 9 P14: the strip behind the card says what a drag does.
    <div className="relative">
      <SwipeLabel dx={dx} toSend={toSend} />
      <article
        id={`t-${p.threadId}`}
        aria-labelledby={`t-${p.threadId}-name`}
        className="relative flex touch-pan-y scroll-mt-4 scroll-mb-28 flex-col gap-3 rounded-xl border bg-card p-4 transition-transform motion-reduce:transition-none sm:scroll-mb-4"
        style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {p.notice}
        <header className="flex flex-col gap-1">
          {/* Check 32 P9 / P11: the customer's name is the card's heading, and wraps if long. */}
          <div className="flex flex-wrap items-baseline justify-between gap-x-2">
            <h3 id={`t-${p.threadId}-name`} className="min-w-0 text-lg font-black break-words">
              {/* Check 13 P9: the name links to their Customers page when there is one. */}
              <CustomerName name={p.customer} customerKey={p.customerKey ?? null} />
              <span className="sr-only"> · draft reply</span>
            </h3>
            <ConfidenceTag label={p.label} />
          </div>
          <ToLine
            address={p.toAddress}
            fromReplyTo={p.toFromReplyTo}
            fromName={p.fromName}
            fromAddress={p.fromAddress}
          />
          <span className="text-base font-semibold">{p.tag}</span>
          {p.wrote ? <span className="text-base">{p.wrote}</span> : null}
          {(p.leadLines ?? []).map((line) => (
            <p key={line} className="text-sm font-semibold">
              {line}
            </p>
          ))}
          {p.openingLine ? <p className="text-sm font-semibold">{p.openingLine}</p> : null}
          {p.noteLine}
          {/* Check 9 P12: what the customer wants, once. The sorting reason is in Why this?,
            and stands in here only when there's no summary. */}
          {p.summary ? (
            <p className="font-semibold">{p.summary}</p>
          ) : p.reason ? (
            <p>{withoutCategoryPrefix(p.reason)}</p>
          ) : null}
          {/* Check 20 P7: why autopilot left this one for you (fixed words, never email text). */}
          {p.autopilotWait ? <p className="text-sm font-semibold">{p.autopilotWait}</p> : null}
        </header>

        {p.needsOwnerReason && !(p.summary && p.inRightNow) ? (
          <p className="font-semibold">Needs you: {withoutCategoryPrefix(p.needsOwnerReason)}</p>
        ) : null}
        {p.permitCard}

        {p.autoSendAt ? (
          <form
            action={holdAutopilotAction}
            role="status"
            className="sa-inverted flex flex-col gap-2 rounded-lg p-3"
          >
            <input type="hidden" name="draftId" value={p.draftId} />
            <CardTargets threadId={p.threadId} />
            <AutopilotCountdown sendAt={p.autoSendAt} clock={p.autoSendClock ?? ""} />
            <Pending label="Hold it" busy="Holding…" className="w-full" />
          </form>
        ) : null}

        {p.timingNote && !p.readOnly ? (
          <div role="note" className="rounded-lg border-2 border-charcoal p-3">
            <p className="font-black">{p.timingNote}</p>
            <p className="text-sm">Read it again before it goes, or tap Edit to change it.</p>
          </div>
        ) : null}

        {p.languageLine ? <p className="font-semibold">{p.languageLine}</p> : null}

        {p.flags.length || p.label === "check_everything" ? (
          <div className="rounded-lg border-2 border-charcoal p-3">
            <p className="font-black">Check before sending</p>
            <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
              {p.label === "check_everything" ? (
                <li>Not sure this one is right — read it closely.</li>
              ) : null}
              {p.flags.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {editing ? (
          <DraftEditor
            draftId={p.draftId}
            threadId={p.threadId}
            nextThreadId={p.nextThreadId}
            body={body}
            kept={kept}
            seenHash={p.seenHash}
            toAddress={p.toAddress}
            toLine={
              <ToLine
                address={p.toAddress}
                fromReplyTo={p.toFromReplyTo}
                fromName={p.fromName}
                fromAddress={p.fromAddress}
              />
            }
            canSend={p.canSend}
            confirmTiming={!!p.timingNote}
            onCancel={() => {
              restoreEditFocus();
              setKept(null);
              setEditing(false);
            }}
          />
        ) : null}
        {editing ? null : (
          <>
            <div ref={bodyBox} className="rounded-lg border bg-paper p-3">
              {p.subject ? (
                <p className="mb-1 text-sm break-words text-muted-foreground">
                  <span className="font-semibold">Subject:</span> {p.subject}
                </p>
              ) : null}
              <BodyWithGaps
                body={body}
                onChange={setBody}
                openGap={openGap}
                onOpenGap={setOpenGap}
                expanded={expanded}
                onToggle={() => setExpanded((v) => !v)}
                // Check 9 P7: no Send reply ever sits under hidden text.
                clamp={!(p.canSend && !p.readOnly)}
                readOnly={p.readOnly}
                priceSuggestions={pastPrices}
              />
            </div>

            {pastPrices.length ? (
              <PastPrices
                prices={pastPrices}
                canFill={priceGap >= 0 && !p.readOnly}
                readOnly={p.readOnly}
                onUse={usePrice}
              />
            ) : null}

            <WhyThis reason={p.reason} usedFacts={p.usedFacts} flags={p.flags} />
            {p.readOnly ? null : p.moreActions}

            {discardIn !== null ? (
              <form
                ref={discardForm}
                action={discardDraftAction}
                className="sa-inverted flex flex-col gap-2 rounded-lg p-3"
              >
                <input type="hidden" name="draftId" value={p.draftId} />
                <CardTargets threadId={p.threadId} next={p.nextThreadId} />
                <DiscardCountdown left={discardIn} />
                {discardIn > 0 ? (
                  <Button type="button" className="w-full" onClick={() => setDiscardIn(null)}>
                    Undo
                  </Button>
                ) : null}
              </form>
            ) : confirmDiscard ? (
              <form
                action={discardDraftAction}
                aria-labelledby={discardTitle}
                onKeyDown={closeOnEscape(keepDraft)}
                className="sa-inverted flex flex-col gap-2 rounded-lg p-3"
              >
                <input type="hidden" name="draftId" value={p.draftId} />
                <CardTargets threadId={p.threadId} next={p.nextThreadId} />
                <QuestionLine id={discardTitle} className="font-semibold">
                  {p.nudge
                    ? "Discard this nudge? It's removed from Gmail too, and we won't nudge them again on this one unless you write to them."
                    : "Discard this draft? It's removed from Gmail too."}
                </QuestionLine>
                <Pending label="Discard draft" busy="Discarding…" className="w-full" />
                <Button type="button" variant="ghost" className="w-full" onClick={keepDraft}>
                  Keep it
                </Button>
              </form>
            ) : (
              <div ref={sendArea} className="grid grid-cols-1 gap-2">
                {p.canSend && gapsLeft > 0 ? (
                  // Check 9 P11: a real button — it opens the first blank to fill. The server
                  // still refuses to send a reply with a gap in it.
                  <Button
                    type="button"
                    variant="outline"
                    size="lg"
                    className="w-full border-2 border-charcoal font-black"
                    onClick={openFirstGap}
                  >
                    Fill in {gapsLeft} gap{gapsLeft === 1 ? "" : "s"} to send
                  </Button>
                ) : p.canSend && waitingForSignal ? (
                  <div role="note" tabIndex={-1} className="flex flex-col gap-2">
                    <p className="font-black">Will send when you&apos;re back online.</p>
                    <p className="text-sm text-muted-foreground">
                      It&apos;s checked again first — if it changed, it waits for you.
                    </p>
                    <Button
                      type="button"
                      variant="outline"
                      className="w-full"
                      onClick={() => removeIntent(p.draftId)}
                    >
                      Don&apos;t send it
                    </Button>
                  </div>
                ) : p.canSend ? (
                  <form
                    action={sendDraftAction}
                    onSubmit={okayOffline}
                    // Check 8 P1: with offline okays on, the no-signal guard lets this one through
                    // (it's kept on the phone); otherwise a tap with no signal is stopped first.
                    data-offline-ok={p.offlineEnabled ? "" : undefined}
                  >
                    <input type="hidden" name="draftId" value={p.draftId} />
                    <CardTargets threadId={p.threadId} next={p.nextThreadId} />
                    <input type="hidden" name="seen" value={p.seenHash} />
                    {p.toAddress ? <input type="hidden" name="seenTo" value={p.toAddress} /> : null}
                    {body !== p.body ? <input type="hidden" name="body" value={body} /> : null}
                    {p.timingNote ? <input type="hidden" name="confirmedTiming" value="1" /> : null}
                    <SendButton label={p.timingNote ? "Send reply anyway" : "Send reply"} />
                  </form>
                ) : (
                  <>
                    <div
                      role="note"
                      tabIndex={-1}
                      className="sa-inverted flex min-h-12 flex-col justify-center rounded-lg px-4 py-2"
                    >
                      <span className="font-black">{p.sendingOffLabel}</span>
                      <span className="text-sm text-ash">{p.sendingOffDetail}</span>
                    </div>
                    {p.practiceLeft != null && !p.readOnly ? (
                      p.practiceLeft > 0 ? (
                        <form action={practiceSendAction} className="flex flex-col gap-1">
                          <input type="hidden" name="draftId" value={p.draftId} />
                          <CardTargets threadId={p.threadId} />
                          {body !== p.body ? (
                            <input type="hidden" name="body" value={body} />
                          ) : null}
                          <Pending
                            label="Send it to yourself instead"
                            busy="Sending to you…"
                            variant="outline"
                            className="w-full"
                          />
                          <span className="text-sm text-muted-foreground">
                            A practice copy to your own inbox to see how it reads. Your customer
                            gets nothing. {p.practiceLeft} left.
                          </span>
                        </form>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          You&apos;ve used all your practice sends.
                        </span>
                      )
                    ) : null}
                  </>
                )}
                {p.readOnly ? null : (
                  <div className={canChange ? "grid grid-cols-3 gap-2" : "grid grid-cols-2 gap-2"}>
                    {/* Edit sits under the thumb: right by default, left if mirrored. Discard is
                      on the far side; Change it, when there, in the middle. */}
                    <Button
                      ref={editOpener}
                      type="button"
                      variant="outline"
                      className={p.leftHanded ? "order-1" : "order-3"}
                      onClick={() => {
                        setChanging(false);
                        setEditing(true);
                      }}
                    >
                      Edit
                    </Button>
                    {canChange ? (
                      <Button
                        type="button"
                        variant={changing ? "default" : "outline"}
                        aria-expanded={changing}
                        aria-controls={`change-${p.draftId}`}
                        className="order-2"
                        onClick={() => setChanging((v) => !v)}
                      >
                        Change it
                      </Button>
                    ) : null}
                    <Button
                      ref={discardOpener}
                      type="button"
                      variant="outline"
                      className={p.leftHanded ? "order-3" : "order-1"}
                      onClick={() => setConfirmDiscard(true)}
                    >
                      Discard
                    </Button>
                  </div>
                )}
                {canChange && p.otherWays ? (
                  <OtherWaysToReply
                    draftId={p.draftId}
                    threadId={p.threadId}
                    seenHash={p.seenHash}
                    cardBody={cardBody}
                  />
                ) : null}
                {canChange && changing ? (
                  <div
                    id={`change-${p.draftId}`}
                    className="flex flex-col gap-3 rounded-lg border p-3"
                  >
                    <p className="text-sm text-muted-foreground">
                      Each change writes a new version for you to read. Nothing is sent.
                    </p>
                    <TweakChips
                      draftId={p.draftId}
                      threadId={p.threadId}
                      seenHash={p.seenHash}
                      cardBody={cardBody}
                    />
                    <SayAChange
                      draftId={p.draftId}
                      threadId={p.threadId}
                      seenHash={p.seenHash}
                      cardBody={cardBody}
                    />
                  </div>
                ) : null}
                {p.readOnly || (p.nudge !== "quote" && p.nudge !== "invoice") ? null : (
                  // Check 21 P8: close the matter from the nudge card.
                  <form action={p.nudge === "quote" ? nudgeSaidNoAction : nudgeAlreadyPaidAction}>
                    <CardTargets threadId={p.threadId} next={p.nextThreadId} />
                    <Pending
                      label={p.nudge === "quote" ? "They said no" : "Already paid"}
                      busy="Saving…"
                      variant="outline"
                      className="w-full"
                    />
                  </form>
                )}
                {/* Check 9 P12: side by side; a question that opens takes the whole row. */}
                <div className="grid grid-cols-2 gap-2 [&:has(>form)>*]:col-span-2 [&>*:only-child]:col-span-2">
                  <RemindMe
                    threadId={p.threadId}
                    nextThreadId={p.nextThreadId}
                    options={p.remindOptions ?? []}
                    compact
                  />
                  {p.readOnly ? null : (
                    <CalledThem
                      threadId={p.threadId}
                      nextThreadId={p.nextThreadId}
                      hasDraft
                      compact
                    />
                  )}
                </div>
              </div>
            )}
            {/* Check 43 P4: under the reply and its buttons, so Send reply stays on the first screen. */}
            {p.noSignatureLine ? (
              <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
                <span>{p.noSignatureLine}</span>
                <Link
                  href={SIGNATURE_FIELD_HREF}
                  className="inline-flex min-h-tap items-center font-semibold text-foreground underline underline-offset-4"
                >
                  Add a signature
                </Link>
              </p>
            ) : null}
          </>
        )}
        {/* Under the buttons, so it never pushes Send reply down. */}
        {p.swipeTip && !p.readOnly ? <SwipeTip leftHanded={p.leftHanded} /> : null}
      </article>
    </div>
  );
}
