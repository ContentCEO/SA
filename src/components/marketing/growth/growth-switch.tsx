"use client";

import { useEffect, useRef } from "react";
import { BigWordsStage } from "./big-words";
import { BW_DONE_MS, BW_QUIET_DONE_MS, BW_REALIGN_AT_MS, BW_THEME_AT_MS } from "./big-words-rules";
import {
  LINES,
  NAV_MS,
  SETTLE_MS,
  jumpMode,
  nextMode,
  rootHeight,
  rootMarginFor,
  switchPath,
  tapPlaysShow,
  type HalfMode,
  type SwitchPath,
} from "./switch-rules";

const THEME = "data-sa-theme";
const SWITCHING = "data-sa-switching";
/** Swallowed (capture phase, on the document) while the full show covers the screen. */
const TAP_EVENTS = ["click", "pointerup", "mousedown"] as const;
/** Scrolling input, also stopped while the full show covers the screen (the page holds still). */
const SCROLL_EVENTS = ["wheel", "touchmove"] as const;
const SCROLL_KEYS = new Set([
  "PageDown",
  "PageUp",
  " ",
  "Spacebar",
  "ArrowDown",
  "ArrowUp",
  "Home",
  "End",
]);
/** Where a key does its own thing (a space in a field), so it's never stopped. */
const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/**
 * The homepage switch from the app to Squared Away Growth, played as "Big words" (big-words.tsx).
 * Scrolling decides it, nothing is tapped: every time the Growth part comes up from the bottom of
 * the screen, five charcoal bands slam in carrying "The app" in huge words, the whole site's
 * colours swap underneath them (`data-sa-theme` on <html>, see src/styles/theme.css), the words
 * tick over to "One-on-one", hold, and the bands fly back out onto the one-on-one opener (#growth):
 * under the bands the page is moved there and held still (wheel, touch and scroll keys are
 * stopped), so the switch always lands on the opener, however fast the scroll. Back up until
 * Growth drops off the bottom, and bands of charcoal fly apart onto paper ("out").
 *
 * Rules in switch-rules.ts, the clock in big-words-rules.ts. Two IntersectionObservers, no scroll
 * listeners (except a short one right after navigation, see markNav, and the wheel / touch / key
 * holds during the full show). The full show plays on every crossing from the app into Growth,
 * one at a time: a decision made while a show or wipe plays waits for it and then plays quietly
 * ("in-quiet" / "out"). A pointer tap on a `#growth` link while on the app side plays the full
 * show too, every time (and adds the #growth history entry under the cover, as the link would);
 * in Growth it is a plain jump to the opener. Navigation (other # links, keyboard activation,
 * keyboard focus moving into Growth, back/forward, bfcache), load, a hidden tab and reduced
 * motion get an instant swap.
 * Without JS nothing here runs and the Growth part keeps its own charcoal.
 *
 * The stage is decorative: aria-hidden, inert, pointer-events none. While the full show covers the
 * screen, taps are swallowed, so nothing hidden under the bands (a tel: link, a form) can be hit,
 * and scrolling is held. Every show's timers and holds end in finish() (or on unmount), before the
 * next one can start.
 * Mounted only on `/`; unmounting removes its attributes so no other page is affected.
 */
export function GrowthSwitch() {
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = document.documentElement;
    const target = document.querySelector<HTMLElement>('[data-sa-half="growth"]');
    if (!target) return;
    const opener = document.getElementById("growth");
    const stage = stageRef.current;

    const vh = () => window.innerHeight;
    const topNow = () => target.getBoundingClientRect().top;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");

    let mode: HalfMode = nextMode("app", topNow(), vh());
    root.setAttribute(THEME, mode);

    const timers = new Set<number>();
    const later = (fn: () => void, ms: number) => {
      const id = window.setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };
    const clearTimers = () => {
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
    };

    // Settling: every decision is instant until all three are true.
    const reported = [false, false];
    let loaded = false;
    let settleTimePassed = false;
    const rafs: number[] = [];
    const settled = () => reported[0] && reported[1] && loaded && settleTimePassed;
    const instantNow = () => !settled() || document.hidden || reduce.matches;

    let playing = false;
    let pending: HalfMode | null = null;
    // The queued decision came from navigation, so it is applied instantly at cleanup.
    let pendingInstant = false;
    // Navigation happened during the full show: the page is where it took the visitor, so the
    // show doesn't move it to the opener.
    let navInShow = false;
    let finishCurrent: (() => void) | null = null;
    // A #growth tap's history entry: added under full cover, or at cleanup if the show ends early.
    let underCover: (() => void) | null = null;

    // Navigation: readings until navUntil are instant and pick a side without the band.
    let navUntil = 0;
    let navRaf = 0;
    const inNav = () => performance.now() < navUntil;

    // Taps while the full show covers the screen land on nothing, and the page holds still.
    const swallow = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const hold = (e: Event) => {
      if (e.cancelable) e.preventDefault();
    };
    const holdKeys = (e: KeyboardEvent) => {
      if (!SCROLL_KEYS.has(e.key)) return;
      if ((e.target as Element | null)?.closest?.(EDITABLE)) return;
      e.preventDefault();
    };
    const holdOpts: AddEventListenerOptions = { capture: true, passive: false };
    let swallowing = false;
    const swallowTaps = (on: boolean) => {
      if (on === swallowing) return;
      swallowing = on;
      for (const t of TAP_EVENTS) {
        if (on) document.addEventListener(t, swallow, true);
        else document.removeEventListener(t, swallow, true);
      }
      for (const t of SCROLL_EVENTS) {
        if (on) document.addEventListener(t, hold, holdOpts);
        else document.removeEventListener(t, hold, holdOpts);
      }
      if (on) document.addEventListener("keydown", holdKeys, true);
      else document.removeEventListener("keydown", holdKeys, true);
    };

    // The switch lands on the opener: the page is moved there under full cover (and again just
    // before the bands leave, in case a fling's momentum carried on), unless navigation took it
    // elsewhere.
    const land = () => {
      if (navInShow || !opener) return;
      opener.scrollIntoView({ block: "start", behavior: "instant" });
    };

    const runUnderCover = () => {
      const fn = underCover;
      underCover = null;
      fn?.();
    };

    const setInstant = (next: HalfMode) => {
      mode = next;
      root.setAttribute(THEME, next);
    };

    const play = (next: HalfMode, path: Exclude<SwitchPath, "instant">) => {
      playing = true;
      mode = next;
      // The stage's style is brought up to date first, on every path. A queued decision starts in
      // the same task as the last show or wipe ended (finish() → go()), and every path's bands run
      // sa-bw-out-*, so without this the browser would keep that one's finished animations and the
      // bands would stay off-screen: a bare colour cut. data-sa-switching is always absent here, so
      // the stage computes display none, which drops them and each path starts from 0.
      stage?.getBoundingClientRect();
      if (path === "in") {
        root.setAttribute(SWITCHING, "in");
        swallowTaps(true);
        // Mid full-cover: the swap and the move to the opener are never seen.
        later(() => {
          root.setAttribute(THEME, "growth");
          runUnderCover();
          land();
        }, BW_THEME_AT_MS);
        later(land, BW_REALIGN_AT_MS);
        finishCurrent = () => finish("growth");
        later(finishCurrent, BW_DONE_MS);
      } else {
        root.setAttribute(THEME, next);
        root.setAttribute(SWITCHING, path);
        finishCurrent = () => finish(next);
        later(finishCurrent, BW_QUIET_DONE_MS);
      }
    };

    const go = (next: HalfMode, path: SwitchPath) => {
      if (path === "instant") setInstant(next);
      else play(next, path);
    };

    function finish(applied: HalfMode) {
      clearTimers();
      finishCurrent = null;
      // Theme first, so a late timer can never take the bands away onto the old colours.
      root.setAttribute(THEME, applied);
      runUnderCover();
      root.removeAttribute(SWITCHING);
      swallowTaps(false);
      playing = false;
      navInShow = false;
      const next = pending;
      const nav = pendingInstant;
      pending = null;
      pendingInstant = false;
      if (next && next !== applied) go(next, switchPath(next, nav || instantNow(), true));
    }

    const decide = (next: HalfMode, instant: boolean) => {
      if (playing) {
        pending = next;
        pendingInstant = pendingInstant || instant || inNav();
        return;
      }
      if (next === mode) return;
      go(next, switchPath(next, instant || instantNow(), false));
    };

    const onEntries = (which: 0 | 1) => (entries: IntersectionObserverEntry[]) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      reported[which] = true;
      const top = entry.boundingClientRect.top;
      // The height this observer measured against, so the decision agrees with its line.
      const h = rootHeight(entry.rootBounds?.bottom, LINES[which], vh());
      if (inNav()) decide(jumpMode(top, h), true);
      else decide(nextMode(playing ? (pending ?? mode) : mode, top, h), false);
    };

    // Each fires when the wrapper's top edge crosses its line (the wrapper runs to the end of the
    // page, so a jump past a line fires too).
    const observers = LINES.map(
      (line, i) =>
        new IntersectionObserver(onEntries(i as 0 | 1), {
          rootMargin: rootMarginFor(line),
          threshold: 0,
        }),
    );
    for (const o of observers) o.observe(target);

    // A navigation may land without crossing a line, so for its window a scroll also takes a
    // reading (one per frame). The listener goes once the window has passed.
    const onNavScroll = () => {
      if (!inNav()) {
        window.removeEventListener("scroll", onNavScroll);
        return;
      }
      if (navRaf) return;
      navRaf = window.requestAnimationFrame(() => {
        navRaf = 0;
        decide(jumpMode(topNow(), vh()), true);
      });
    };
    const markNav = () => {
      navUntil = performance.now() + NAV_MS;
      if (playing) navInShow = true;
      window.addEventListener("scroll", onNavScroll, { passive: true });
    };

    const onClick = (e: MouseEvent) => {
      if (swallowing) return; // swallow() deals with it
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!a) return;
      const href = a.getAttribute("href") ?? "";
      if (!href.startsWith("#")) return;
      // The way in from the hero or the header is the switch too. Keyboard activation (detail 0)
      // keeps the native jump, which also moves the focus starting point.
      const plain = e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
      const pointer = e.detail > 0 && plain;
      if (opener && tapPlaysShow({ href, pointer, mode, playing, instant: instantNow() })) {
        e.preventDefault();
        e.stopPropagation(); // Next's <Link> would navigate as well
        // The entry the link would add, so Back returns to where the tap was: pushed before land()
        // moves the page, so the entry left behind keeps the old scroll position. None when the
        // address already ends in #growth (the link, and Next, would only replace it, so taps
        // don't stack copies). null: Next's patched pushState copies its own state and syncs
        // the router URL.
        underCover =
          window.location.hash === "#growth"
            ? null
            : () => window.history.pushState(null, "", "#growth");
        play("growth", "in");
        return;
      }
      markNav();
      // Any other way to #growth while the address already ends in it (in Growth, a keyboard
      // jump, a tap mid-wipe): Next's <Link> doesn't move the page for the address it's on, so
      // the page is taken to the opener here, as a plain link would be.
      if (href === "#growth" && opener && plain && window.location.hash === "#growth") {
        e.preventDefault();
        e.stopPropagation();
        opener.scrollIntoView({ block: "start", behavior: "instant" });
      }
    };
    document.addEventListener("click", onClick, true);

    // Keyboard focus moving into Growth (Tab from the waitlist) scrolls the page itself: that's
    // navigation, so the swap is instant and the focused control is never hidden under the cover.
    let keyed = false;
    const onKeyInput = () => {
      keyed = true;
    };
    const onPointerInput = () => {
      keyed = false;
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!keyed || mode !== "app") return;
      if (!(e.target instanceof Node) || !target.contains(e.target)) return;
      markNav();
    };
    document.addEventListener("keydown", onKeyInput, true);
    document.addEventListener("pointerdown", onPointerInput, true);
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("hashchange", markNav);
    window.addEventListener("popstate", markNav);

    const afterLoad = () => {
      rafs.push(
        window.requestAnimationFrame(() => {
          rafs.push(
            window.requestAnimationFrame(() => {
              loaded = true;
            }),
          );
        }),
      );
    };
    if (document.readyState === "complete") afterLoad();
    else window.addEventListener("load", afterLoad, { once: true });
    // Kept apart from the show's timers, which finish() clears.
    const settleTimer = window.setTimeout(() => {
      settleTimePassed = true;
    }, SETTLE_MS);

    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      if (finishCurrent) finishCurrent();
      decide(jumpMode(topNow(), vh()), true);
    };
    window.addEventListener("pageshow", onPageShow);

    // Reduced motion switched on mid-show: end it now.
    const onReduce = () => {
      if (reduce.matches && finishCurrent) finishCurrent();
    };
    if (reduce.addEventListener) reduce.addEventListener("change", onReduce);
    else reduce.addListener(onReduce);

    return () => {
      for (const o of observers) o.disconnect();
      clearTimers();
      swallowTaps(false);
      underCover = null;
      window.clearTimeout(settleTimer);
      for (const id of rafs) window.cancelAnimationFrame(id);
      if (navRaf) window.cancelAnimationFrame(navRaf);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyInput, true);
      document.removeEventListener("pointerdown", onPointerInput, true);
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("hashchange", markNav);
      window.removeEventListener("popstate", markNav);
      window.removeEventListener("scroll", onNavScroll);
      window.removeEventListener("load", afterLoad);
      window.removeEventListener("pageshow", onPageShow);
      if (reduce.removeEventListener) reduce.removeEventListener("change", onReduce);
      else reduce.removeListener(onReduce);
      root.removeAttribute(THEME);
      root.removeAttribute(SWITCHING);
    };
  }, []);

  return (
    <div ref={stageRef} className="sa-switch-stage" aria-hidden="true" inert data-sa-switch-stage>
      <BigWordsStage />
    </div>
  );
}
