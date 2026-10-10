"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useFormStatus } from "react-dom";
import type { Tweak } from "@/ai/prompts/revise.v1";
import { Button } from "@/components/ui/button";
import { reviseDraftAction } from "./actions";

/** Plan #3. `Record<Tweak, …>` makes a tweak without a chip a compile error. */
const TWEAK_LABELS: Record<Tweak, string> = {
  shorter: "Shorter",
  warmer: "Warmer",
  formal: "More formal",
  photos: "Ask for photos",
  availability: "Add my availability",
};

function Chip({ tweak, label }: { tweak: Tweak; label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" name="tweak" value={tweak} variant="outline" disabled={pending}>
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
export function TweakChips({ draftId }: { draftId: string }) {
  return (
    <form action={reviseDraftAction} aria-label="Quick changes" className="flex flex-col gap-2">
      <input type="hidden" name="draftId" value={draftId} />
      <div className="flex flex-wrap gap-2">
        {(Object.keys(TWEAK_LABELS) as Tweak[]).map((t) => (
          <Chip key={t} tweak={t} label={TWEAK_LABELS[t]} />
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

/**
 * Plan #4: say (or type) a change — "make it Tuesday instead". Hold to talk
 * where the browser supports it; the words land in the box to check first.
 */
export function SayAChange({ draftId }: { draftId: string }) {
  const [text, setText] = useState("");
  // False on the server and where the browser has no speech recognition.
  const canTalk = useSyncExternalStore(
    noop,
    () => speechCtor() !== null,
    () => false,
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
        <>
          <Button
            type="button"
            variant="outline"
            aria-pressed={listening}
            className="w-full select-none"
            onPointerDown={startTalking}
            onPointerUp={stopTalking}
            onPointerLeave={stopTalking}
            onKeyDown={(e) => (e.key === " " || e.key === "Enter") && startTalking()}
            onKeyUp={(e) => (e.key === " " || e.key === "Enter") && stopTalking()}
          >
            {listening ? "Listening… let go when done" : "Hold to talk"}
          </Button>
          <p className="text-sm text-muted-foreground">
            Your browser sends your voice to Google or Apple to turn it into text.
          </p>
        </>
      ) : null}
      {text.trim().length >= 2 ? <UseThis /> : null}
    </form>
  );
}
