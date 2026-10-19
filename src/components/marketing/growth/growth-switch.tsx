"use client";

import { useEffect, useRef } from "react";
import { BigWordsStage } from "./big-words";
import { BW_DONE_MS, BW_QUIET_DONE_MS, BW_REALIGN_AT_MS, BW_THEME_AT_MS } from "./big-words-rules";
import {
  HOLD_MS,
  LINES,
  NAV_MS,
  crossingCause,
  deferredMode,
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
 * the screen, five charcoal bands slam in carrying "Your inbox" in huge words, the whole site's
 * colours swap underneath them (`data-sa-theme` on <html>, see src/styles/theme.css), the words
 * tick over to "Your marketing", hold, and the bands fly back out onto the one-on-one opener (#growth):
 * under the bands the page is moved there and held still (wheel, touch and scroll keys are
 * stopped), so the switch always lands on the opener, however fast the scroll. Back up until
 * Growth drops off the bottom, and bands of charcoal fly apart onto paper ("out").
 *
 * Rules in switch-rules.ts, the clock in big-words-rules.ts. Two IntersectionObservers and one
 * passive scroll listener that only notes when the visitor last scrolled (a line crossed without a
 * scroll — the page changing shape — waits for their next scroll; see crossingCause), plus a short
 * one right after navigation (markNav) and the wheel / touch / key holds during the full show. The full show plays on every crossing from the app into Growth,
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
 * and scrolling is held. Every show's steps run on the bands' own clock (onShowClock), and its
 * clock and holds end in finish() (or on unmount), before the next one can start.
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

    // Check 32 P3: while the Growth bar covers the paper header (Growth mode, and the bar stuck
    // to the top of the screen), the header's links can't take focus (inert), so Tab never
    // lands on something hidden. Scrolled up so the header shows again, it works again.
    const siteHeader = document.querySelector<HTMLElement>("[data-site-header]");
    const chapterBar = target.firstElementChild as HTMLElement | null;
    let inertRaf = 0;
    const syncHeaderInert = () => {
      if (!siteHeader) return;
      const covered =
        root.getAttribute(THEME) === "growth" &&
        !!chapterBar &&
        chapterBar.getBoundingClientRect().top <= 1;
      if (covered) siteHeader.setAttribute("inert", "");
      else siteHeader.removeAttribute("inert");
    };
    const onInertScroll = () => {
      if (inertRaf) return;
      inertRaf = window.requestAnimationFrame(() => {
        inertRaf = 0;
        syncHeaderInert();
      });
    };
    window.addEventListener("scroll", onInertScroll, { passive: true });
    const setTheme = (m: HalfMode) => {
      root.setAttribute(THEME, m);
      syncHeaderInert();
    };

    let mode: HalfMode = nextMode("app", topNow(), vh());
    setTheme(mode);

    // The show's clock (E2E hardening, 2026-10-19): the bands' own animations, not timers counted
    // from setting data-sa-switching. The bands start in the first frame after that, and on a slow
    // phone that frame comes late: a 380ms timer swapped the colours with the bands barely a third
    // of the way in at CPU x12. Each step now runs in the first frame in which the bands have
    // played that long, so that frame paints it with the bands where the timeline says. That frame
    // can still come late (frames 700ms apart there), so the swap also adds the bands' way out
    // (theme.css) and the realign and cleanup count on that: bands in → swap → bands out, at any
    // CPU speed. A frame-driven clock also waits while a hidden tab draws nothing, and catches up
    // in its first frame back. No band animations (none running): counted from now, as the
    // timers were.
    let clockRun = 0;
    let clockRaf = 0;
    const stopClock = () => {
      clockRun++;
      if (clockRaf) window.cancelAnimationFrame(clockRaf);
      clockRaf = 0;
    };
    /** When the bands started: null until every one has (their first frame hasn't come yet). */
    const bandsStartedAt = (anims: Animation[]): number | null => {
      let at: number | null = null;
      for (const a of anims) {
        if (a.startTime === null) return null;
        const t = Number(a.startTime);
        at = at === null ? t : Math.min(at, t);
      }
      return at;
    };
    /**
     * Runs each step once the bands' animations named `prefix…` have played `ms` (steps in time
     * order). Reading them brings the stage's style up to date, so new ones are there (pending).
     */
    const onShowClock = (prefix: string, steps: [ms: number, fn: () => void][]) => {
      stopClock();
      const run = clockRun;
      const anims = stage
        ? [...stage.querySelectorAll(".sa-bw-band")]
            .flatMap((b) => b.getAnimations())
            .filter((a) => (a as CSSAnimation).animationName?.startsWith(prefix))
        : [];
      let origin: number | null = anims.length ? null : performance.now();
      const frame = (now: number) => {
        clockRaf = 0;
        if (run !== clockRun) return;
        origin ??= bandsStartedAt(anims);
        const timeline = document.timeline.currentTime;
        const t = timeline === null ? now : Number(timeline);
        while (origin !== null && steps.length && run === clockRun && t - origin >= steps[0]![0]) {
          steps.shift()![1]();
        }
        if (steps.length && run === clockRun) clockRaf = window.requestAnimationFrame(frame);
      };
      clockRaf = window.requestAnimationFrame(frame);
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
      setTheme(next);
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
        const done = () => finish("growth");
        finishCurrent = done;
        onShowClock("sa-bw-in-", [
          // Mid full-cover: the swap and the move to the opener are never seen.
          [
            BW_THEME_AT_MS,
            () => {
              setTheme("growth");
              runUnderCover();
              land();
              // The swap adds the bands' way out (theme.css): the rest counts on its clock.
              onShowClock("sa-bw-out-", [
                [BW_REALIGN_AT_MS - BW_THEME_AT_MS, land],
                [BW_DONE_MS - BW_THEME_AT_MS, done],
              ]);
            },
          ],
        ]);
      } else {
        setTheme(next);
        root.setAttribute(SWITCHING, path);
        const done = () => finish(next);
        finishCurrent = done;
        onShowClock("sa-bw-out-", [[BW_QUIET_DONE_MS, done]]);
      }
    };

    const go = (next: HalfMode, path: SwitchPath) => {
      if (path === "instant") setInstant(next);
      else play(next, path);
    };

    function finish(applied: HalfMode) {
      stopClock();
      finishCurrent = null;
      // Theme first, so the bands can never be taken away onto the old colours.
      setTheme(applied);
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

    // Only a scroll moves the switch: a line crossed by the page changing shape under a still
    // screen (the waitlist form turning into its thank-you, a FAQ answer folding) waits for the
    // visitor's next scroll. A passive scroll listener notes when they last scrolled, and while a
    // thank-you is brought into view ("sa:hold-switch") that scroll isn't theirs.
    let lastScrollAt = Number.NEGATIVE_INFINITY;
    let heldUntil = 0;
    const held = () => performance.now() < heldUntil;
    let deferredFromY: number | null = null;
    let deferRaf = 0;
    const onScroll = () => {
      if (held()) {
        if (deferredFromY !== null) deferredFromY = window.scrollY;
        return;
      }
      lastScrollAt = performance.now();
      if (deferredFromY === null || deferRaf) return;
      deferRaf = window.requestAnimationFrame(() => {
        deferRaf = 0;
        if (deferredFromY === null || held()) return;
        const next = deferredMode({
          startScrollY: deferredFromY,
          scrollY: window.scrollY,
          top: topNow(),
          h: vh(),
        });
        if (!next) return;
        deferredFromY = null;
        decide(next, false);
      });
    };
    const onHold = () => {
      heldUntil = performance.now() + HOLD_MS;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("sa:hold-switch", onHold);

    const onEntries = (which: 0 | 1) => (entries: IntersectionObserverEntry[]) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      reported[which] = true;
      const top = entry.boundingClientRect.top;
      // The height this observer measured against, so the decision agrees with its line.
      const h = rootHeight(entry.rootBounds?.bottom, LINES[which], vh());
      if (inNav()) {
        deferredFromY = null;
        decide(jumpMode(top, h), true);
        return;
      }
      const current = playing ? (pending ?? mode) : mode;
      const next = nextMode(current, top, h);
      const cause = crossingCause({
        msSinceUserScroll: performance.now() - lastScrollAt,
        inNav: false,
        held: held(),
      });
      // Before the page settles every decision is instant anyway (and must land: a load at
      // #growth), so only a settled page waits.
      if (next !== current && settled() && !playing && cause === "layout") {
        deferredFromY = window.scrollY;
        return;
      }
      deferredFromY = null;
      decide(next, false);
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
    // Kept apart from the show's clock, which finish() stops.
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
      stopClock();
      swallowTaps(false);
      underCover = null;
      window.clearTimeout(settleTimer);
      for (const id of rafs) window.cancelAnimationFrame(id);
      if (navRaf) window.cancelAnimationFrame(navRaf);
      if (deferRaf) window.cancelAnimationFrame(deferRaf);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("sa:hold-switch", onHold);
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
      window.removeEventListener("scroll", onInertScroll);
      window.cancelAnimationFrame(inertRaf);
      siteHeader?.removeAttribute("inert");
    };
  }, []);

  return (
    <div ref={stageRef} className="sa-switch-stage" aria-hidden="true" inert data-sa-switch-stage>
      <BigWordsStage />
    </div>
  );
}
