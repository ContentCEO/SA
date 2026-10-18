# w2-phone: Phone look and accessibility (wave 2)

Branch `w2-phone`, from 2a580e0. No migration, no prompt change, no new fetch host (so no privacy
policy line), no price, plan or flow change, no new send path.

## For CLAUDE.md (Decisions)

- **Phone tab bar and focus (Check 32 P2, Check 8 P2/P5, 2026-10-18):** the bottom `<nav>` has
  `data-tabbar`; under 640px `html:has([data-tabbar])` gets `scroll-padding-bottom: calc(3.5rem +
1px + env(safe-area-inset-bottom) + 12px)` and `scroll-padding-top: 16px` (rem, so it follows a
  bigger text setting and Sunlight). The viewport is `viewport-fit=cover`; the (app) wrapper
  (`#sa-app`, class `sa-app`) pads all four safe areas with `max()`, bottom
  `calc(7rem + env(safe-area-inset-bottom))`; the bar's list pads left/right; every other page
  pads on `<body>` (`html:not(:has([data-tabbar])) body`); `public/offline.html` likewise. Tabs:
  `li` min-w-0, pill `w-full max-w-11`, label `min(0.875rem, 3.6vw)` leading-tight; the header
  wraps (Sunlight drops below the logo) only at a very big text setting. Manual iPhone checks:
  docs/SETUP.md §11 "Phone checks".
- **Back to the app (Check 8 P3):** `RefreshOnReturn` (in the (app) layout) calls
  `router.refresh()` when the app comes back after ≥60s hidden, never while a text box has focus
  or anything has `data-editing="true"` (the draft card while Edit or Change it is open); then it
  waits until the field loses focus / the editor closes. Rules in `src/lib/refresh-rules.ts`.
  Tapping the tab you're on scrolls to the top (smooth unless reduced motion) and refreshes.
  Queue, Inbox, Quotes and Money show "Updated 9:41 AM" (owner's zone, server time) under the
  headline; offline: "No signal. This is your queue from 9:41 AM." (`UpdatedAt`).
- **Sunlight is client-only (Check 8 P4):** `SunlightButton` flips `data-contrast` on `#sa-app`
  and writes `sa_contrast` with `document.cookie` (path=/, 400 days, SameSite=Lax, Secure on
  https; max-age=0 to switch off). The cookie is no longer httpOnly (a display setting, nothing
  secret); hand and offline cookies unchanged. `toggleSunlightAction` is gone. Cookie names live
  in `src/lib/device-cookies.ts` (no server-only), re-exported by `device-prefs.ts`.
- **Notices are read out (Check 32 P5):** one always-present polite live region (`Announcer`,
  root layout), in a **closed shadow root** so the words (already on screen once) don't appear
  twice in the page text: a plain-DOM copy broke 37 e2e tests that find a notice with
  `getByText`, and would match twice in find-in-page. `Notice` (now a client component) keeps
  `role="status"` but `aria-live="off"` and writes its words into the region 100ms after
  clearing it. **Strong notices stay `role="alert"`** on the notice itself (announced as it
  appears); the spec's second alert region was left out because it would read an error twice.
  e2e reads the region from Chromium's accessibility tree (`tests/e2e/announcer.ts`).
- **Focus after a settings save (Check 32 P5):** `AutoSaveForm` notes the changed switch
  (name, plus value for radios) in sessionStorage (`sa_focus_after_save`) before
  `requestSubmit`; `FocusAfterSave` (in the (app) layout, /settings/* only) puts focus back on
  it once the screen is back with `?done=`/`?error=` (≤15s, same path), else on the submit
  button (`data-refocus` key: `followups-save`, `sms-alerts-toggle`; a Save under radios goes to
  the chosen radio), else on the notice (tabIndex -1). Only control names, values and fixed keys
  are stored.
- **Public sticky bars (Check 32 P3):** `--sa-sticky-top` (theme.css, 3.5rem + 1rem + 1px: the
  73px Growth bar) + 12px is the `scroll-padding-top` of `/` and `/growth`; the old
  `scroll-mt-*` on the Growth opener, `#growth-call` and the two thank-yous are gone (the padding
  does that now, so anchor jumps land about 13px lower than before). GrowthSwitch makes the
  homepage header (`data-site-header`) **inert while Growth mode is on and the Growth bar is
  stuck over it** (bar top ≤ 1px) — not for the whole of Growth mode, because scrolled up a
  little the header shows again and its links must work.
- **Focus ring on inverted controls (Check 32 P4):** `.sa-inverted:is(a, button, summary,
[tabindex]):focus-visible` = charcoal outline outside + off-white inset ring (Sunlight: hc
  constants; Growth mode and `/growth`: swapped).
- **Titles (Check 32 P6):** root `title: { default: "Squared Away", template: "%s · Squared Away" }`;
  homepage, /growth, /privacy, /terms use `title.absolute`; every page sets a short title
  (`tests/unit/page-titles.test.ts`); Queue is "Queue (N)" from `badgeCount` (number only).
- **axe in e2e (Check 32 P8):** `@axe-core/playwright` 4.13.0 (exact; 4.14.0 was 3 days old);
  `tests/e2e/a11y.spec.ts` fails on serious/critical (wcag2a/aa, 21a/aa, 22aa) for public
  pages, owner, owner settings, trial owner and admin, both projects. Review chips:
  `aria-current="true"` + sr-only " (chosen)"; Wordmark is `role="img"`.
- **Fields (Check 32 P10):** `<label htmlFor>` holds only the label text; hint and error sit
  beside the control (id `${idBase ?? name}-field`) and are its description.
- **Skip link (Check 32 P12):** `SkipLink` first on every screen; every `<main>` is
  `id="main" tabIndex={-1}`. The crash and not-found pages show "Stuck? Call … or email …"
  (`HelpLine`; the root layout hands `SUPPORT_EMAIL` to the client crash page through
  `SupportEmailProvider`).
- **Taps (Check 8 P6/P8/P10):** /more has a loading.tsx; tab pills invert on the tap
  (`useLinkStatus`). 8px between neighbouring targets (checklist, Quotes filter, hand choice,
  footer lines, admin waitlist Growth block); the footer email is its own 44px line;
  `tests/e2e/tap-targets.spec.ts` sweeps owner / trial / admin at 375 and 320px. Sideways
  (landscape, height ≤ 500px): page headline loses its serif line, heavy 1.75rem, tighter gaps,
  48px tab bar with labels beside icons.
- **Sunlight weights (Check 7 P2):** a second `next/font/local` instance (`interTightRange`,
  "100 900", `--font-inter-tight-range`) from the same file; the sunlight block points
  `--font-sans`, `--font-heading` **and `--font-inter-tight`** at it (`@theme inline` writes
  `var(--font-inter-tight)` straight into the utilities). Normal mode unchanged.
- **Icons (Check 7 P3):** /app-icon draws in Inter Tight Black (`src/app/_og`, traced in
  next.config.ts); `src/app/icon.svg` is outlined paths (fontTools, once); `scripts/favicon.ts`
  rebuilds favicon.ico (16 + 32) with Next's own sharp.
- **Inversion = status (Check 7 P5/P9/P11, Check 1 P5):** Activity's money panel, Billing's
  suggested plan and the learning screen's voice card are `border-2 border-charcoal bg-card`;
  "Your plan" marks the current plan. No `opacity-*` greys on text (`two-tone.test.ts`); ghost
  buttons only in confirm components (`buttons.test.ts`); every field uses `border-input`
  (`input-contrast.test.ts` scans them); autofill stays two-tone; no tap highlight.

## For docs/LAUNCH.md (Davi to-dos)

- Tick the two iPhone checks in docs/SETUP.md §11 (home bar in the installed app; nothing under
  the notch sideways).

## Questions for Davi

1. The installed app is locked upright on Android (`orientation: "portrait"` in the manifest).
   Sideways now works in the browser and on iPhone. Keep the lock, or let it turn?
2. A strong notice (an error) is read out by the notice itself as an alert, not through a second
   hidden region as the review suggested, so it's never read twice. Fine?

## Integration notes

- Queue screen group: also touches the tab bar (hide-while-typing) and the draft card. Mine adds
  `data-tabbar`, `sa-tab` / `sa-tab-pill` classes, the `TabPill` component (useLinkStatus) and
  an `onClick` (second tap → top + refresh) to the tab links in `app-header.tsx`, and
  `data-editing` on the draft card's `<article>`. Hide-while-typing should keep `data-tabbar`
  on the bar's `<nav>`.
- `Notice` is now a client component with `role="status" aria-live="off"`; the live words are in
  a closed shadow root. Tests should keep finding notices with `getByText` /
  `getByRole("status")` as before; to check what's announced, use `tests/e2e/announcer.ts`.
- The (app) wrapper is `#sa-app` with class `sa-app`; its padding classes changed (safe areas).
- e2e tap-target sweeps must skip `.sr-only:not(:focus)` (the skip link).
- `src/app/(app)/admin/page.tsx`: two small spacing changes (8px) and the Audience link size.
