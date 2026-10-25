"use client";

import { useEffect, useRef } from "react";
import { ANNOUNCER_ID, registerRegion } from "@/lib/announce";

/**
 * Check 32 P5: the page's polite live region, empty until a Notice writes into it
 * (src/lib/announce.ts). Always present, outside any screen, so it survives moves between
 * screens and a save that lands back on the same one. The region sits in the host's closed
 * shadow root (see registerRegion).
 */
export function Announcer() {
  const id = ANNOUNCER_ID;
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const shadow = el.shadowRoot ?? attached.get(el) ?? el.attachShadow({ mode: "closed" });
    attached.set(el, shadow);
    let live = shadow.firstElementChild as HTMLElement | null;
    if (!live) {
      live = document.createElement("div");
      live.setAttribute("role", "status");
      live.setAttribute("aria-live", "polite");
      live.setAttribute("aria-atomic", "true");
      shadow.append(live);
    }
    registerRegion(id, live);
    return () => registerRegion(id, null);
  }, [id]);
  return <div ref={host} id={id} className="sr-only" />;
}

/** A host can take one shadow root; remember it across effect re-runs (dev Strict Mode). */
const attached = new WeakMap<HTMLElement, ShadowRoot>();
