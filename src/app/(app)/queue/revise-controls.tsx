"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useFormStatus } from "react-dom";
import type { OpeningTweak } from "@/ai/prompts/opening-tweaks.v1";
import type { Tweak } from "@/ai/prompts/revise.v2";
import { Button } from "@/components/ui/button";
import { OPENING_TWEAK_LABELS, TWEAK_LABELS } from "@/config/tweaks";
import { reviseDraftAction } from "./actions";

function Chip({ name = "tweak", value, label }: { name?: string; value: string; label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" name={name} value={value} variant="outline" disabled={pending}>
      {label}
    </Button>
  );
}

function Rewriting() {
  const { pending } = useFormStatus();
  return pending ? (
    <p role="status" className="font-semibold">
      Rewriting… nothing is sent.
    </p>
  ) : null;
}

/** One-tap rewrites. The new text comes back to the queue to read; nothing sends. */
type ReviseProps = {
  draftId: string;
  threadId: string;
  seenHash: string;
  /**
   * Check 23 P8: the card's text with the gaps the owner filled in, posted only when it differs
   * from the saved text, so a quick change keeps what they typed.
   */
  cardBody?: string;
};

function CardBody({ cardBody }: { cardBody?: string }) {
  return cardBody !== undefined ? <input type="hidden" name="body" value={cardBody} /> : null;
}

export function TweakChips({ draftId, threadId, seenHash, cardBody }: ReviseProps) {
  return (
    <form action={reviseDraftAction} aria-label="Quick changes" className="flex flex-col gap-2">
      <input type="hidden" name="draftId" value={draftId} />
      <input type="hidden" name="threadId" value={threadId} />
      <input type="hidden" name="seen" value={seenHash} />
      <CardBody cardBody={cardBody} />
      <div className="flex flex-wrap gap-2">
        {(Object.keys(TWEAK_LABELS) as Tweak[]).map((t) => (
          <Chip key={t} value={t} label={TWEAK_LABELS[t]} />
        ))}
      </div>
      <Rewriting />
    </form>
  );
}

/**
 * Replies package: "Other ways to reply" on a first reply to a new lead. Each chip rewrites the
 * draft through the same revise flow as the tweaks (same limits); the new text comes back to
 * read. Nothing sends.
 */
export function OtherWaysToReply({ draftId, threadId, seenHash, cardBody }: ReviseProps) {
  const heading = `other-ways-${draftId}`;
  return (
    <form action={reviseDraftAction} aria-labelledby={heading} className="flex flex-col gap-2">
      <input type="hidden" name="draftId" value={draftId} />
      <input type="hidden" name="threadId" value={threadId} />
      <input type="hidden" name="seen" value={seenHash} />
      <CardBody cardBody={cardBody} />
      <p id={heading} className="font-semibold">
        Other ways to reply
      </p>
      <div className="flex flex-wrap gap-2">
        {(Object.keys(OPENING_TWEAK_LABELS) as OpeningTweak[]).map((t) => (
          <Chip key={t} name="opening" value={t} label={OPENING_TWEAK_LABELS[t]} />
        ))}
      </div>
      <Rewriting />
    </form>
  );
}

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
};

function speechCtor(): (new () => Recognition) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as Record<string, unknown>;
  return ((w.SpeechRecognition ?? w.webkitSpeechRecognition) as new () => Recognition) ?? null;
}

const noop = () => () => {};

function UseThis() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "Rewriting…" : "Change the draft"}
    </Button>
  );
}

/** Check 48 P5: true for every browser that shows Hold to talk. */
export const VOICE_NOTE_GENERAL =
  "Your browser sends what you say to its maker (Google, Apple or Microsoft) to turn it into text. Prefer not to? Type it in the box.";

/**
 * Check 48 P5: the note under Hold to talk. Names one company only when the browser clearly
 * says which (Microsoft Edge on a computer, Apple's Safari); otherwise the general sentence.
 * The user-agent text is read in the browser only — never stored, sent or logged.
 */
export function voiceNote(userAgent: string): string {
  const tail = " to turn it into text. Prefer not to? Type it in the box.";
  if (/\bEdg\//.test(userAgent)) return `Your browser sends what you say to Microsoft${tail}`;
  if (
    /\bVersion\/[\d.]+.*\bSafari\//.test(userAgent) &&
    !/Chrome|Chromium|CriOS|FxiOS|EdgiOS|OPR|Android/.test(userAgent)
  )
    return `Your browser sends what you say to Apple${tail}`;
  return VOICE_NOTE_GENERAL;
}

/** Hold to talk, always with its note (Check 48 P5: never one without the other). */
export function HoldToTalk({
  listening,
  onStart,
  onStop,
  note,
}: {
  listening: boolean;
  onStart: () => void;
  onStop: () => void;
  note: string;
}) {
  return (
    <>
      <Button
        type="button"
        variant="outline"
        aria-pressed={listening}
        className="w-full select-none"
        onPointerDown={onStart}
        onPointerUp={onStop}
        onPointerLeave={onStop}
        onKeyDown={(e) => (e.key === " " || e.key === "Enter") && onStart()}
        onKeyUp={(e) => (e.key === " " || e.key === "Enter") && onStop()}
      >
        {listening ? "Listening… let go when done" : "Hold to talk"}
      </Button>
      <p className="text-base text-muted-foreground">{note}</p>
    </>
  );
}

/**
 * Plan #4: say (or type) a change — "make it Tuesday instead". Hold to talk
 * where the browser supports it; the words land in the box to check first.
 */
export function SayAChange({ draftId, threadId, seenHash, cardBody }: ReviseProps) {
  const [text, setText] = useState("");
  // False on the server and where the browser has no speech recognition.
  const canTalk = useSyncExternalStore(
    noop,
    () => speechCtor() !== null,
    () => false,
  );
  const userAgent = useSyncExternalStore(
    noop,
    () => navigator.userAgent,
    () => "",
  );
  const [listening, setListening] = useState(false);
  const rec = useRef<Recognition | null>(null);

  useEffect(() => {
    return () => rec.current?.stop();
  }, []);

  const startTalking = () => {
    const Ctor = speechCtor();
    if (!Ctor || listening) return;
    const r = new Ctor();
    r.lang = "en-US";
    r.interimResults = true;
    r.continuous = true;
    r.onresult = (e) => {
      let said = "";
      for (let i = 0; i < e.results.length; i++) said += e.results[i]![0]!.transcript;
      setText(said.trim().slice(0, 500));
    };
    r.onerror = () => setListening(false);
    r.onend = () => setListening(false);
    rec.current = r;
    setListening(true);
    r.start();
  };
  const stopTalking = () => rec.current?.stop();

  return (
    <form action={reviseDraftAction} className="flex flex-col gap-2">
      <input type="hidden" name="draftId" value={draftId} />
      <input type="hidden" name="threadId" value={threadId} />
      <input type="hidden" name="seen" value={seenHash} />
      <CardBody cardBody={cardBody} />
      <label className="flex flex-col gap-1.5">
        <span className="font-semibold">Tell it what to change</span>
        <textarea
          name="spoken"
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 500))}
          rows={2}
          placeholder="Make it Tuesday instead"
          className="w-full rounded-lg border border-input bg-paper px-3 py-2.5 text-base"
        />
      </label>
      {canTalk ? (
        <HoldToTalk
          listening={listening}
          onStart={startTalking}
          onStop={stopTalking}
          note={voiceNote(userAgent)}
        />
      ) : null}
      {text.trim().length >= 2 ? <UseThis /> : null}
    </form>
  );
}
