"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { addNeverSayAction } from "../settings/wording-actions";
import { findGaps } from "@/ai/gaps";
import type { ConfidenceLabel } from "@/config/drafting";
import { BodyWithGaps, ConfidenceTag, WhyThis } from "./draft-parts";
import { SayAChange, TweakChips } from "./revise-controls";
import { RemindMe, type SnoozeOption } from "./remind-me";
import {
  discardDraftAction,
  holdAutopilotAction,
  saveDraftEditAction,
  sendDraftAction,
} from "./actions";

export type DraftCardProps = {
  draftId: string;
  threadId: string;
  /** Plan #6: the "Remind me" times allowed for this one right now. */
  remindOptions?: SnoozeOption[];
  customer: string;
  tag: string;
  /** One line on what the customer wants, from sorting — so the card reads without opening Gmail. */
  summary?: string | null;
  reason: string;
  body: string;
  flags: string[];
  /** Plan #8: Ready / Check the details / Check everything. */
  label: ConfidenceLabel;
  /** Plan #1: profile facts and voice traits the drafter used (keys). */
  usedFacts: string[];
  /** Plan #9: mirror the swipes and the button order for a left thumb. */
  leftHanded?: boolean;
  /** Quick tweaks / voice edits left (0 hides them). */
  revisionsLeft?: number;
  needsOwnerReason: string | null;
  canSend: boolean;
  /** Read-only account: show the draft, but no edit, discard or swipe. */
  readOnly?: boolean;
  /** Autopilot will send this at this (formatted) time unless held. */
  autoSendAt?: string | null;
  sendingOffLabel: string;
  sendingOffDetail: string;
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
  const [expanded, setExpanded] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);
  const buzzed = useRef(false);
  const sendArea = useRef<HTMLDivElement>(null);
  const discardForm = useRef<HTMLFormElement>(null);
  const [discardIn, setDiscardIn] = useState<number | null>(null);
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
  const editor = useRef<HTMLTextAreaElement>(null);
  // The body as the owner sees it — gaps they fill in change it before sending.
  const [body, setBody] = useState(p.body);
  const gapsLeft = findGaps(body).length;
  const [neverSayNote, setNeverSayNote] = useState<string | null>(null);
  const [savingPhrase, startSaving] = useTransition();
  const neverSay = () => {
    const el = editor.current;
    const phrase = el ? el.value.slice(el.selectionStart, el.selectionEnd).trim() : "";
    if (!phrase) {
      setNeverSayNote("Select the words first — press and hold, then drag.");
      return;
    }
    startSaving(async () => setNeverSayNote((await addNeverSayAction(phrase)).message));
  };

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
    <article
      aria-label={`Draft reply to ${p.customer}`}
      className="flex touch-pan-y flex-col gap-3 rounded-xl border bg-card p-4 transition-transform motion-reduce:transition-none"
      style={{ transform: dx ? `translateX(${dx}px)` : undefined }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-lg font-black">{p.customer}</span>
          <ConfidenceTag label={p.label} />
        </div>
        <span className="text-sm font-semibold">{p.tag}</span>
        {p.summary ? <p className="font-semibold">{p.summary}</p> : null}
        <p className={p.summary ? "text-muted-foreground" : undefined}>{p.reason}</p>
      </header>

      {p.needsOwnerReason ? <p className="font-semibold">Needs you: {p.needsOwnerReason}</p> : null}

      {p.autoSendAt ? (
        <form
          action={holdAutopilotAction}
          role="status"
          className="sa-inverted flex flex-col gap-2 rounded-lg p-3"
        >
          <input type="hidden" name="draftId" value={p.draftId} />
          <p>
            <span className="font-black">Autopilot sends this at {p.autoSendAt}</span>{" "}
            <span className="text-ash">unless you hold it.</span>
          </p>
          <Pending label="Hold it" busy="Holding…" className="w-full" />
        </form>
      ) : null}

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
        <form className="flex flex-col gap-3">
          <input type="hidden" name="draftId" value={p.draftId} />
          <label className="flex flex-col gap-1.5">
            <span className="font-semibold">Your reply</span>
            <textarea
              ref={editor}
              name="body"
              defaultValue={body}
              rows={10}
              autoFocus
              className="w-full rounded-lg border border-input bg-paper px-3 py-2.5 text-base"
            />
          </label>
          {p.canSend ? (
            <Pending
              formAction={sendDraftAction}
              label="Send reply"
              busy="Sending…"
              size="lg"
              className="w-full"
            />
          ) : null}
          <Pending
            formAction={saveDraftEditAction}
            label="Save changes"
            busy="Saving…"
            variant="outline"
            className="w-full"
          />
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={savingPhrase}
            onClick={neverSay}
          >
            {savingPhrase ? "Adding…" : "Never say this"}
          </Button>
          {neverSayNote ? (
            <p role="status" className="text-sm font-semibold">
              {neverSayNote}
            </p>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            className="w-full"
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
        </form>
      ) : null}
      {editing && (p.revisionsLeft ?? 0) > 0 ? (
        <div className="flex flex-col gap-2 border-t pt-3">
          <p className="text-sm text-muted-foreground">
            Or let us rewrite it — this replaces the draft with a new version to read.
          </p>
          <SayAChange draftId={p.draftId} />
        </div>
      ) : null}
      {editing ? null : (
        <>
          <div className="rounded-lg border bg-paper p-3">
            <BodyWithGaps
              body={body}
              onChange={setBody}
              expanded={expanded}
              readOnly={p.readOnly}
            />
            <button
              type="button"
              className="mt-1 inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Show less" : "Show full draft"}
            </button>
          </div>

          <WhyThis reason={p.reason} usedFacts={p.usedFacts} flags={p.flags} />

          {!p.readOnly && !confirmDiscard && discardIn === null && (p.revisionsLeft ?? 0) > 0 ? (
            <TweakChips draftId={p.draftId} />
          ) : null}

          {discardIn !== null ? (
            <form
              ref={discardForm}
              action={discardDraftAction}
              role="status"
              className="sa-inverted flex flex-col gap-2 rounded-lg p-3"
            >
              <input type="hidden" name="draftId" value={p.draftId} />
              <p className="font-semibold">
                {discardIn > 0
                  ? `Discarding in ${discardIn}… It's removed from Gmail too.`
                  : "Discarding…"}
              </p>
              {discardIn > 0 ? (
                <Button type="button" className="w-full" onClick={() => setDiscardIn(null)}>
                  Undo
                </Button>
              ) : null}
            </form>
          ) : confirmDiscard ? (
            <form
              action={discardDraftAction}
              className="sa-inverted flex flex-col gap-2 rounded-lg p-3"
            >
              <input type="hidden" name="draftId" value={p.draftId} />
              <p className="font-semibold">Discard this draft? It&apos;s removed from Gmail too.</p>
              <Pending label="Discard draft" busy="Discarding…" className="w-full" />
              <Button
                type="button"
                variant="ghost"
                className="w-full"
                onClick={() => setConfirmDiscard(false)}
              >
                Keep it
              </Button>
            </form>
          ) : (
            <div ref={sendArea} className="grid grid-cols-1 gap-2">
              {p.canSend && gapsLeft > 0 ? (
                <div
                  role="note"
                  tabIndex={-1}
                  className="flex min-h-12 items-center justify-center rounded-lg border-2 border-charcoal px-4 font-black"
                >
                  Fill in {gapsLeft} gap{gapsLeft === 1 ? "" : "s"} to send
                </div>
              ) : p.canSend ? (
                <form action={sendDraftAction}>
                  <input type="hidden" name="draftId" value={p.draftId} />
                  {body !== p.body ? <input type="hidden" name="body" value={body} /> : null}
                  <Pending label="Send reply" busy="Sending…" size="lg" className="w-full" />
                </form>
              ) : (
                <div
                  role="note"
                  tabIndex={-1}
                  className="sa-inverted flex min-h-12 flex-col justify-center rounded-lg px-4 py-2"
                >
                  <span className="font-black">{p.sendingOffLabel}</span>
                  <span className="text-sm text-ash">{p.sendingOffDetail}</span>
                </div>
              )}
              {p.readOnly ? null : (
                <div className="grid grid-cols-2 gap-2">
                  {/* The main button sits under the thumb: right by default, left if mirrored. */}
                  <Button
                    type="button"
                    variant="outline"
                    className={p.leftHanded ? undefined : "order-2"}
                    onClick={() => setEditing(true)}
                  >
                    Edit
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setConfirmDiscard(true)}>
                    Discard
                  </Button>
                </div>
              )}
              <RemindMe threadId={p.threadId} options={p.remindOptions ?? []} />
            </div>
          )}
        </>
      )}
    </article>
  );
}
