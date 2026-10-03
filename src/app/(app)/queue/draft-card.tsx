"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { discardDraftAction, saveDraftEditAction, sendDraftAction } from "./actions";

export type DraftCardProps = {
  draftId: string;
  customer: string;
  tag: string;
  reason: string;
  body: string;
  flags: string[];
  lowConfidence: boolean;
  needsOwnerReason: string | null;
  canSend: boolean;
  /** Read-only account: show the draft, but no edit, discard or swipe. */
  readOnly?: boolean;
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

/**
 * One draft in the queue. Swipe left (on a phone) to reach Discard — it asks
 * once; swiping never sends. Send reply is always a deliberate tap.
 */
export function DraftCard(p: DraftCardProps) {
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [dx, setDx] = useState(0);
  const start = useRef<{ x: number; y: number } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (editing || p.readOnly || e.pointerType === "mouse") return;
    start.current = { x: e.clientX, y: e.clientY };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!start.current) return;
    const x = e.clientX - start.current.x;
    const y = e.clientY - start.current.y;
    if (Math.abs(y) > Math.abs(x)) return; // scrolling, not swiping
    setDx(Math.min(0, Math.max(-140, x)));
  };
  const onPointerUp = () => {
    if (dx <= -SWIPE_REVEAL) setConfirmDiscard(true);
    setDx(0);
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
        <span className="text-lg font-black">{p.customer}</span>
        <span className="text-sm font-semibold">{p.tag}</span>
        <p>{p.reason}</p>
      </header>

      {p.needsOwnerReason ? <p className="font-semibold">Needs you: {p.needsOwnerReason}</p> : null}

      {p.flags.length || p.lowConfidence ? (
        <div className="rounded-lg border-2 border-charcoal p-3">
          <p className="font-black">Check before sending</p>
          <ul className="mt-1 flex list-disc flex-col gap-1 pl-5">
            {p.lowConfidence ? <li>Not sure this one is right — read it closely.</li> : null}
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
              name="body"
              defaultValue={p.body}
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
            variant="ghost"
            className="w-full"
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
        </form>
      ) : (
        <>
          <div className="rounded-lg border bg-paper p-3">
            <p className={cn("whitespace-pre-line", !expanded && "line-clamp-4")}>{p.body}</p>
            <button
              type="button"
              className="mt-1 inline-flex min-h-tap items-center font-semibold underline underline-offset-4"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? "Show less" : "Show full draft"}
            </button>
          </div>

          {confirmDiscard ? (
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
            <div className="grid grid-cols-1 gap-2">
              {p.canSend ? (
                <form action={sendDraftAction}>
                  <input type="hidden" name="draftId" value={p.draftId} />
                  <Pending label="Send reply" busy="Sending…" size="lg" className="w-full" />
                </form>
              ) : (
                <div
                  role="note"
                  className="sa-inverted flex min-h-12 flex-col justify-center rounded-lg px-4 py-2"
                >
                  <span className="font-black">{p.sendingOffLabel}</span>
                  <span className="text-sm text-ash">{p.sendingOffDetail}</span>
                </div>
              )}
              {p.readOnly ? null : (
                <div className="grid grid-cols-2 gap-2">
                  <Button type="button" variant="outline" onClick={() => setEditing(true)}>
                    Edit
                  </Button>
                  <Button type="button" variant="outline" onClick={() => setConfirmDiscard(true)}>
                    Discard
                  </Button>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </article>
  );
}
