"use client";

import { useEffect, useState } from "react";
import { Notice } from "@/components/app/notice";

/**
 * `#t-<uuid>`: a link from the morning summary (or a notification) to one card. A
 * notification opens `/queue?t=<uuid>#t-<uuid>` (a real page load); the `?t=` alone also works.
 */
const THREAD_HASH = /^#t-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The URL this tab last scrolled to a card for. Module state, so it lasts across remounts within
 * one page load but resets on a real load (a notification tap, a summary link, a reload), which
 * is a new landing and scrolls again.
 */
let lastScrolledHref = "";

function linkedHash(): string {
  if (window.location.hash) return window.location.hash;
  const t = new URLSearchParams(window.location.search).get("t");
  return t ? `#t-${t}` : "";
}

/**
 * Plan #31: brings the linked card into view with its top (the customer's name) at the top of
 * the screen, less the card's `scroll-mt-4`. Not centred: a draft card is often taller than a
 * phone screen, and centring it pushed its name off the top and its bottom under the fixed tab
 * bar. The queue streams in behind its loading placeholder, so the browser's own jump to
 * `#t-…` happens before the card exists; this runs once the cards are on the page, and again
 * whenever the hash changes. If the card isn't there (dealt with, or snoozed since the summary
 * went out) it says so, rather than leaving the owner at the top wondering.
 *
 * The page renders this with a fresh `key` on every server render, so any later navigation or
 * queue action remounts it and drops a "not on your queue" notice that belonged to the earlier
 * link — the same lifetime as the page's `?done=` / `?error=` notices. Most queue actions
 * redirect to `/queue?…`, but some re-render the page in place and keep the URL, `#t-…` and all:
 * the header's Sunlight toggle and the draft editor's "Never say this". So a remount scrolls only
 * on a new landing (see `lastScrolledHref`); it still re-checks the notice.
 */
export function ScrollToThread() {
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const go = (always: boolean) => {
      const hash = linkedHash();
      if (!THREAD_HASH.test(hash)) return setMissing(false);
      const card = document.getElementById(hash.slice(1).toLowerCase());
      // Check 9 P5: after a tap the page lands on the next card; if that one has gone too (the
      // last card), the tap's own notice says what happened — no "not on your queue" as well.
      // (Only for the action's own `?t=`; a `#t-` link still says it's gone.)
      const afterTap =
        !window.location.hash && /[?&](done|error|sent)=/.test(window.location.search);
      setMissing(!card && !afterTap);
      if (!card) return;
      // A re-render of the same URL (Sunlight, "Never say this") must not pull the owner back
      // to the card they've already landed on and scrolled away from.
      if (!always && window.location.href === lastScrolledHref) return;
      lastScrolledHref = window.location.href;
      const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      card.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
    };
    // A hash change is a new target, so it always scrolls.
    const onHashChange = () => go(true);
    go(false);
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return missing ? <Notice>That email isn&apos;t on your queue right now.</Notice> : null;
}
