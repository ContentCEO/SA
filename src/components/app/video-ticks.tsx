"use client";

import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "@/components/ui/button";

/**
 * Check 28 P7: tick boxes for the demo-video steps. Ticks live in this device's localStorage only
 * (a per-device convenience, wrapped in try/catch, never sent anywhere); Clear ticks empties them.
 * Rows and their text come from the server (the doc); this component only remembers ticks.
 * Read through useSyncExternalStore so the server render (no ticks) hydrates cleanly and the
 * device's ticks appear right after.
 */
const KEY = "sa_video_ticks";
const NONE = "[]";

const listeners = new Set<() => void>();
/** Where ticks go when storage is blocked (a private window): this page view only. */
let memory = NONE;

function subscribe(cb: () => void) {
  listeners.add(cb);
  window.addEventListener("storage", cb);
  return () => {
    listeners.delete(cb);
    window.removeEventListener("storage", cb);
  };
}

function snapshot(): string {
  try {
    return localStorage.getItem(KEY) ?? memory;
  } catch {
    return memory;
  }
}

function write(ticks: Set<string>) {
  const json = JSON.stringify([...ticks]);
  memory = json;
  try {
    localStorage.setItem(KEY, json);
  } catch {
    // Private window or blocked storage: the ticks last for this page view only.
  }
  for (const l of listeners) l();
}

function parse(raw: string): Set<string> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export type TickRow = { key: string; label: string; children?: ReactNode };

export function VideoTicks({ rows, heading }: { rows: TickRow[]; heading: string }) {
  const raw = useSyncExternalStore(subscribe, snapshot, () => NONE);
  const ticks = useMemo(() => parse(raw), [raw]);

  const toggle = (key: string) => {
    const next = new Set(ticks);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    write(next);
  };
  const done = rows.filter((r) => ticks.has(r.key)).length;

  return (
    <section aria-labelledby="video-steps" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="video-steps" className="text-xl font-black">
          {heading}
        </h2>
        <span className="text-sm text-muted-foreground" aria-live="polite">
          {done} of {rows.length} ticked
        </span>
      </div>
      <ol className="flex flex-col divide-y rounded-xl border">
        {rows.map((r) => {
          const on = ticks.has(r.key);
          const id = `tick-${r.key}`;
          return (
            <li key={r.key} className="flex gap-3 px-3 py-3">
              <span className="flex shrink-0 items-start">
                <input
                  id={id}
                  type="checkbox"
                  checked={on}
                  onChange={() => toggle(r.key)}
                  aria-labelledby={`${id}-label`}
                  className="size-11 shrink-0 accent-foreground"
                />
              </span>
              <div className="flex min-w-0 flex-col gap-1">
                <label
                  id={`${id}-label`}
                  htmlFor={id}
                  className={`flex min-h-tap items-center font-black ${on ? "line-through opacity-60" : ""}`}
                >
                  {r.label}
                </label>
                {r.children ? <div className={on ? "opacity-60" : ""}>{r.children}</div> : null}
              </div>
            </li>
          );
        })}
      </ol>
      <Button
        type="button"
        variant="outline"
        onClick={() => write(new Set())}
        className="self-start"
      >
        Clear ticks
      </Button>
    </section>
  );
}
