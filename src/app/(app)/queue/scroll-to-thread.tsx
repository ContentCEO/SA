"use client";

import { useEffect, useState } from "react";
import { Notice } from "@/components/app/notice";

/**
 * `#t-<uuid>`: a link from the morning summary (or a notification) to one card. A
 * notification opens `/queue?t=<uuid>#t-<uuid>` (a real page load); the `?t=` alone also works.
 */
const THREAD_HASH = /^#t-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function linkedHash(): string {
  if (window.location.hash) return window.location.hash;
  const t = new URLSearchParams(window.location.search).get("t");
  return t ? `#t-${t}` : "";
}

/**
 * Plan #31: brings the linked card into view, centred (so the fixed phone tab bar can't
 * cover it). The queue streams in behind its loading placeholder, so the browser's own jump
 * to `#t-…` happens before the card exists; this runs once the cards are on the page, and
 * again whenever the hash changes. If the card isn't there (dealt with, or snoozed since the
 * summary went out) it says so, rather than leaving the owner at the top wondering.
 */
export function ScrollToThread() {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const go = () => {
      const hash = linkedHash();
      if (!THREAD_HASH.test(hash)) return setMissing(false);
      const card = document.getElementById(hash.slice(1).toLowerCase());
      setMissing(!card);
      if (!card) return;
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      card.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
    };
    go();
    window.addEventListener("hashchange", go);
    return () => window.removeEventListener("hashchange", go);
  }, []);
  return missing ? <Notice>That email isn&apos;t on your queue right now.</Notice> : null;
}
