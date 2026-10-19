# Site and Growth: the public site, the installable app, legal pages and Squared Away Growth

Moved unchanged from `CLAUDE.md`'s "Decisions" section on 2026-10-19 (Check 49 P5), in their
original order. Rules that a test or gate depends on are also stated in `CLAUDE.md`.

- Favicon and wordmark are text placeholders until Davi's icon pack arrives (`public/brand/`).
- **Public site pass (2026-10-11, branch `claude/homepage-fixes`, PR — Davi reviews before merge):**
  `/privacy` and `/terms` render `docs/privacy-policy.md` / `docs/terms.md` (drafts, "Draft — not
  yet reviewed", `[To confirm]` items) through `src/lib/markdown.tsx` (tiny renderer, React elements
  only) with contact details substituted from `site.ts` + `SUPPORT_EMAIL`; footer links on every page.
  Marketing rules: present tense only for what's live on production; never say the app "can't send"
  in general; no shop counts, testimonials, invented numbers or logos; no "GC" (MA = CSL), no license
  number until Davi confirms. Live check 2026-10-11: sorting runs on prod (classify.v2 calls in
  logs); morning summary is not live for owners (Resend test sender) → copy says "When you're set
  up". Security headers in `src/config/security-headers.ts` (CSP with `unsafe-inline` scripts —
  nonces would make every page dynamic; form-action allows Google + Stripe for OAuth/Checkout
  redirects; microphone=(self) kept for M5 voice-to-edit). OG image from committed OFL TTFs in
  `src/app/_og/`; `metadataBase` from `appUrl()`. Waitlist trade + team size are now required.
- **Future goal (after the website is complete):** a downloadable app (phone app store). Not started;
  the site is mobile-first so a wrapper or native shell can reuse it later.
- **Public site (2026-10-05, Davi asked for a sales website):** `/` is the marketing page (signed-in
  users still go to `/queue`); sign-in moved to `/signin` (Auth.js `pages`, `requireOwner` redirect).
  Copy must stay true to the code (scopes, 30-day retention, trial can't send, autopilot rules);
  prices render from `src/config/pricing.ts`. Waitlist form → `waitlist` table (idempotent per
  email, hidden trap field: `sa_hp` since wave 3, `website` still counts from old pages); joining does NOT allow sign-in — Davi taps Invite in
  /admin → Waitlist (`inviteFromWaitlist`). `QueuePreview` is an HTML still of the queue.
- **Installable app (PWA, 2026-10-05):** Davi wants website + downloadable app. `src/app/manifest.ts`
  (start_url /queue, standalone), icons from `src/app/app-icon/[size]/route.tsx` (ImageResponse
  placeholder until the icon pack), Apple web-app metadata, and `public/sw.js` which **never caches
  pages or data** — only `public/offline.html`. Settings → "Get the app" (Install button on
  Android/Chrome, Share → Add to Home Screen steps on iPhone). App-store listings later (Apple
  $99/yr, Google $25) need Davi's okay; a Capacitor/TWA wrapper can reuse this site.
- **Squared Away Growth (2026-10-12, branch `claude/growth-page`, stacked on PR #9):** a separate
  one-on-one marketing service (ads, posts, Google Business Profile, reviews, websites) for anyone
  in the trades. `/growth` (public, static, charcoal edge to edge; no switch, no `data-sa-half`, no
  theme attribute) and the second half of `/`: `<div data-sa-half="app">` (hero … waitlist, then
  `GrowthBridge`, `growth-bridge.tsx`, the paper hinge, no id) and
  `<div class="sa-inverted" data-growth-chapter data-sa-half="growth">` (sticky chapter bar, then
  the opener, which carries `#growth` via `openerId` + `scroll-mt-18`, … Book a free call). All copy in
  `src/components/marketing/growth/growth-copy.ts` (names/phone/company from `siteConfig`; guard
  test bans prices, unlaunched features, he/him/his and "builder"). No Growth prices on the site.
  Services in `src/config/growth.ts`.
  - "Book a free call" (`requestGrowthCallAction`) → the existing `waitlist` table, **no migration**.
    Conventions: `team_size = 'growth-only'` marks a row that exists only for Growth; the note is
    the app note, then ONE `[Growth call]` block (newest request replaces the previous one;
    identical resubmit is a no-op). Read them only through `describeWaitlistEntry`
    (`src/server/growth-note.ts`). Typed `[Growth call]` is scrubbed (both forms). A Growth request
    never changes name/team size/created/invited, **never invites** (`inviteFromWaitlist` →
    `growth_only`; mixed rows invite with the app note only); an app join upgrades a growth-only row.
    `waitlist.phone` is the newest Growth number on a growth-only row, and only the app form's own
    number on an app row (a Growth number lives in its block, so a replaced request leaves no old
    number behind, as the privacy policy says). Email capped at 254 characters (both forms).
  - Shares the `waitlist` hashed-IP limit bucket (10/h across both forms). Content-free notice to
    `ADMIN_EMAIL` ("New Growth call request", Resend idempotency key = HMAC(AUTH_SECRET, email) +
    local date), awaited but capped at 5 s (`GROWTH_NOTIFY_TIMEOUT_MS`) so a hung Resend can't hold
    the form. Logs only `growth_call_requested {existing, services}`. Both form actions catch a
    failed save, log `growth_request_failed` / `waitlist_join_failed {error: name}` and throw a
    content-free error (Next logs whatever an action throws, and a Drizzle error's message carries
    every bound value). Sentry scrub ported
    verbatim from M7 (`src/lib/sentry.ts`) so a failed insert's params never leave;
    `tests/unit/sentry.test.ts` is M7's file (its price_history case included since the launch
    merge), and the Growth case lives in `tests/unit/growth-sentry.test.ts`.
  - **Scroll switch (2026-10-13, Davi: "it's not a tap, they're just scrolling down… it switches,
    boom, to the one-on-one"):** replaces the old CSS scroll-timeline wipe (`GrowthWipe`, `.sa-flip`,
    and the e2e that asserted `animation-timeline` are gone; don't bring them back). `GrowthSwitch`
    (`growth-switch.tsx`, mounted once on `/`, last child) sets `<html data-sa-theme="app|growth">`
    in an effect only (absent without JS, removed on unmount) and `data-sa-switching="in|in-quiet|out"`
    while a transition plays. Two IntersectionObservers on the Growth wrapper (`rootMarginFor`:
    −15% / 0% bottom), no scroll listeners; `nextMode` (`switch-rules.ts`, pure): growth at top ≤
    0.85·vh (the chapter bar just came up: the opener is never readable on paper first), app at ≥
    1.0·vh (back off the bottom edge), else unchanged (hysteresis band, no strobing). Each reading
    is decided against the height **its observer measured** (`rootHeight`, from the entry's
    `rootBounds.bottom` and its line), never `innerHeight` (phone toolbars / pinch zoom make them
    differ, which could strand a reading in the band). Instant (no show) until both observers reported + load + 2 rAFs +
    `SETTLE_MS` 500, and afterwards only for real navigation: a `#` link click, `hashchange`,
    `popstate`, keyboard focus moving into Growth (capture `focusin` inside the wrapper while on the
    app side, last input a key, not a pointer: Tab from the waitlist must not hide the focused link
    under the cover) (readings for `NAV_MS` 1000 after it are instant and band-free via `jumpMode`, line
    at 0.925·vh; a short passive scroll listener covers a landing that crosses no line), bfcache
    `pageshow` (also `jumpMode`), a hidden tab or reduced motion (live matchMedia). No distance-
    based jump rule (a fast flick across both lines must still play the show).
  - **The show is "Big words", and it replays (Davi, 2026-10-14: picked look 4 of the five
    `?look=` previews, and "after one time the animation … doesn't do it ever again … I wanted
    to see the animation more").** The preview chooser (`?look=`, `data-sa-look`, the light
    switch / curtains / tide / blinds looks) and the old flood-and-pill cover are gone; don't
    bring them back. `big-words.tsx` draws it, `big-words-rules.ts` is its clock (mirrored in
    theme.css, comment and declarations unit-checked in `tests/unit/growth-big-words.test.ts`),
    `switch-rules.ts` decides: `switchPath(next, instant, queued)` and `tapPlaysShow(...)` (pure,
    unit-tested). **Every** crossing from the app into Growth plays the full show ("in"), however
    many times it has played (no once-per-page memory anywhere; a unit test greps for one); the
    way back up is always the quiet "out". **Every** pointer tap on a `#growth` link (hero,
    header) while on the app side, settled and not mid-transition plays it too: default and
    Next's Link are stopped, the show plays, and under full cover `pushState(null, "", "#growth")`
    adds the entry the link would have (pushed **before** the page moves, so Back returns to where
    the tap was), or nothing when the address already ends in `#growth` (the link and Next would
    only replace it, so repeated taps don't stack copies). Keyboard activation keeps the native
    jump. A `#growth` click that isn't the show while the address already ends in `#growth` (in
    Growth, keyboard, mid-wipe) is scrolled to the opener by GrowthSwitch itself, because Next's
    Link doesn't move the page for the address it's already on (e2e caught it).
    Full show ("in"): five charcoal bands slam in from alternate sides (240 ms each, the middle
    band first, the outer two from 80 ms, full cover at 320) with "Your inbox" (was "The app"; Check
    6 P6, wave 3) in huge serif in the
    middle band; the theme swaps at `BW_THEME_AT_MS` 380 under full cover **and the page moves to
    the opener** (`#growth`, `scrollIntoView` instant; again at `BW_REALIGN_AT_MS` 1220 in case a
    fling's momentum carried on), so every full show lands on the one-on-one opener with its
    `.sa-land` headline on screen, however fast or slow the scroll (review 2026-10-13: a flick went
    3000px past the opener under the cover, and a slow scroll lifted the cover onto the bridge with
    the opener below the fold); not when navigation (Back etc.) happened during the show. The
    words tick over to "Your marketing" (was "One-on-one") in huge heavy sans (240 ms from 440), which inverts at 680
    (1 ms flip), holds 620 ms, then the bands fly back out the way they came, outer ones first,
    from 1300 (all gone by 1540); `.sa-land` delays 960 / 1020 ms after the swap; cleanup at
    `BW_DONE_MS` 1740 re-applies the theme then drops the attribute. Each band reaches 1px into
    the next (no paper hairline); transforms and 1 ms opacity flips only, no clip-path.
    While it covers the screen, taps are swallowed (capture-phase click / pointerup / mousedown
    on the document, added in `play()`, removed in `finish()` and cleanup), so nothing hidden under
    it (tel: link, form) can be hit, and the page is held still (non-passive wheel / touchmove
    `preventDefault`, and PageUp/Down, Space, arrows, Home/End unless typed in a field). One show
    at a time: decisions during a show or wipe queue as `pending` and play quietly at cleanup
    (`queued` → "in-quiet" / "out"), or instantly when they came from navigation
    (`pendingInstant`); every timer and hold ends in `finish()` before the next can start. Every
    path ("in", "in-quiet", "out") forces a style flush of the stage before setting
    `data-sa-switching` (`getBoundingClientRect` in `play()`, with the attribute absent, so the
    stage computes display none and drops the old animations). A queued path starts in the same
    task the last one ended, and all of them run `sa-bw-out-*`, so without the flush the browser
    keeps the finished animations and the bands stay off-screen: a bare colour cut (review
    2026-10-14; e2e checks a band is on screen during a queued "in-quiet" and a queued "out").
    Quiet paths ("out", and "in-quiet" for a queued way down): bands of the old colour fly apart
    sideways, no words, never fades (`BW_QUIET_MS` 260, cleanup `BW_QUIET_DONE_MS` 300). The stage
    is 100vh. There is **no interactive switch**: the stage is aria-hidden, inert, pointer-events
    none, display none unless switching (and in print / reduced motion).
  - theme.css: the seven colours are written once as `--sa-k-*` constants and the palette points at
    them. `:root[data-sa-theme="growth"]` swaps the palette in place (paper↔charcoal, offwhite↔graphite,
    stone→graphite, slate↔ash, `--input` ash), so the whole site (header, body, cards, AboutDavi,
    the waitlist form) flips with no per-component code; `.sa-inverted` / `.sa-light` get the
    canonical seven plus popover/secondary/accent/destructive back (growth-scoped restore). In app
    mode `[data-sa-half="growth"]` is mapped the other way (paper with charcoal text) so nothing
    dark shows before the switch; its `.sa-light` gets the canonical seven. Every rule is scoped by
    `data-sa-theme`, so nothing changes off `/`.
    `tests/unit/growth-switch.test.ts` guards this and bans literal colours in page.tsx, marketing
    components and the footer (QueuePreview's shadow is allow-listed).
  - **Merged into claude/launch-integration (2026-10-14):** sunlight mode (#37,
    `:root:has([data-contrast="high"])`) used to write literal hexes onto `--sa-*`; they are now
    constants on `:root` too (`--sa-k-hc-charcoal` #111111, `--sa-k-hc-offwhite` #fffef9,
    `--sa-k-hc-black` #000000), the sunlight block points at them, and the "each colour written
    once" test lists them. The two never meet at runtime (`data-contrast` is only on the signed-in
    app's wrapper and `/` redirects signed-in owners to /queue; `data-sa-theme` exists only on
    `/`). The old `.sa-flip` / `view-timeline` block is gone from the launch branch too.
  - AboutDavi stays in the app part. Its old "a working builder." / "He built…" wording broke the
    site's no-"builder" / no-pronouns-for-Davi rule, so on 2026-10-15 (before the production merge)
    it became "who's behind this, someone in the trades." / "It began as the tool for A&C
    Construction's own inbox." (`tests/unit/about-davi.test.ts` guards it like the Growth copy).
    LAUNCH.md step 13 tells Davi and asks if he wants other words.
  - The homepage chapter bar is opaque charcoal and stays pinned to the end of the page (the footer
    is shorter than the screen), so the site header (charcoal by then, after the switch) never
    comes back. Intended.
  - /admin → "Waitlist and Growth calls": chips, the request, Call link, growth-only explanation.
  - Homepage trial FAQ / "Our promise" wording left as on PR #9 (awaiting Davi's review there).
    M11 S5 later changed the trial and deletion wording (see "M11 legal drafts").
- **Public site from the outside review (2026-10-16, P2):**
  - **Waitlist emails** (`src/server/waitlist-emails.ts`), sent from `after()` in
    `joinWaitlistAction` only when the result is "joined" (a new row, or a Growth-only row
    turned into an app sign-up): a content-free "New waitlist sign-up" to `ADMIN_EMAIL` through
    the shared `notifyAdmin` (one per address per day), and "You're on the Squared Away list" to
    the person, **once ever** (`waitlist.confirmation_sent_at`, set only on Resend "sent" /
    "already_sent"). Idempotency keys are HMAC-salted, no address. The confirmation carries
    nothing the visitor typed (anyone can type someone else's address), takes Davi's first name
    from `siteConfig.operator`, has no booking link, and replies go to `SUPPORT_EMAIL` only when
    set. A failure is logged by error name and never fails the sign-up. A repeat sign-up
    ("already") sends nothing, so people who joined before the Resend domain was verified never
    get a confirmation.
  - **Where sign-ups came from:** migration 0029 (additive) adds to `waitlist`: `utm_source`,
    `utm_medium`, `utm_campaign`, `referrer_host`, `confirmation_sent_at`. The browser keeps the
    first touch per tab in sessionStorage (`src/lib/landing-source.ts`); `<SourceFields/>` puts
    hidden fields in the waitlist and Growth forms, `<SourceCapture/>` runs on legal pages. The
    server cleans or drops every field, never errors (`source-rules.ts`; our own hosts dropped,
    `own-hosts.ts`); first touch wins across both forms; /admin shows "Came from: …".
  - **Measurement:** `@vercel/analytics` mounted only on `/`, `/growth`, `/privacy`, `/terms`
    (`SiteAnalytics`, production only via `VERCEL_ENV`; never in the root layout or `(app)`, a
    static test checks). `beforeSend` (`src/lib/analytics-rules.ts`) keeps page views of those
    paths with utm tags only — no `?ref=`, hash or custom events. First-party `/_vercel/insights`,
    so no CSP change; no cookies. Counting starts when Davi enables Analytics in Vercel. Counting
    signed-in screens would need a policy change and his okay.
  - GrowthSwitch layout gate: a line crossed with no real scroll in the last 150 ms (or during
    the 1.2 s hold after a thank-you's `sa:hold-switch`) waits for the visitor's next scroll
    (`crossingCause` / `deferredMode` in `switch-rules.ts`), so a thank-you that grows the page
    never plays the show or leaves the screen. Both thank-yous scroll into view and take focus.
  - Wording: "Business email" + "Gmail or Google Workspace today. On Outlook? Join anyway — it's
    on the list."; the trial is "Squared Away won't send anything to a customer during the
    trial" (never "nothing sends"); follow-ups "Two nudge drafts at most per conversation — each
    waits for your okay."; "Takes two minutes" gone (`legal-docs.test.ts` bans the old phrases
    and "automatic nudge"). The "photo coming soon" box is gone: one column until the `photo`
    constant in `about-davi.tsx` is set.
  - `Headline` (and every hand-written serif-over-heavy pair) has a real space between its two
    lines ("your inbox, handled."). Footer phone is a 44px `tel:` link; footer "Squared Away
    Growth" link on public pages only, plus "See everything Growth does →" on the homepage.
    `/growth` has its own share card (`src/app/_og/share-card.tsx`).
  - `src/app/not-found.tsx` ("nothing here, page not found." + Go to the homepage; /admin still
    a plain 404) and `src/app/error.tsx` (Next 16 `retry`, no message or digest). A failed form
    save returns a plain error keeping what was typed (`unstable_rethrow` first).
  - Search: homepage title "Squared Away — AI email help for contractors"; JSON-LD Organization +
    SoftwareApplication from `pricing.ts` (no rating, no free offer). Homepage caching **not**
    done: it needs the signed-in redirect in `proxy.ts` and `?ref=` read in the browser
    (referral code; after the referral branch merges).
- **Legal docs moved to 2026-10-16 (outside review P4):** the privacy policy now names the form
  Reply-To address in what we store from Gmail and in the kept metadata, the sign-up source
  (utm tags + referring site's name, not the page), the waitlist confirmation and Davi's
  content-free notice (Resend list), and Vercel Web Analytics (cookie-free, public pages only;
  Vercel also listed for it). Both docs' "Last updated" and `TERMS_VERSION` moved to 2026-10-16
  (the rule: the three stay equal); `docs/terms.md` text unchanged. Everyone who agreed to
  2026-10-15 is asked once more (only testers; the gate wasn't live yet then — it is live in
  production since `c1bf580`, PR #11, 2026-10-16). `legal-docs.test.ts`
  holds each new sentence to the code. LAUNCH.md step 13 has "Outside review (2026-10-15)".
- **M11 legal drafts (S5, 2026-10-13):** `docs/privacy-policy.md` and `docs/terms.md` checked
  against the code; `tests/unit/legal-docs.test.ts` is the gate (numbers read from config/code,
  the scope table from `GMAIL_SCOPES`, the three terms `[To confirm]` items unchanged, no
  referral text while #47 is off). Limited Use uses Google's template sentence word for word and
  the merger clause says "only after asking for your explicit permission first". The deletion
  sentence ("Delete my account in Settings deletes your account and everything in it from Squared
  Away, after one confirmation. Stripe keeps its own payment records.") is shared word for word by
  the policy and the homepage FAQ (tested). Trial wording everywhere: nothing can go to a
  customer, practice copies to yourself only — never "sending is switched off completely" (the
  connect explainer and homepage are tested). `outputFileTracingIncludes` ships docs/*.md with
  /privacy and /terms. **Open for Davi (S7 carries these):** the three terms `[To confirm]` items
  (refunds, liability cap, governing law and venue); "plus any taxes" (settled 2026-10-14: Stripe
  Tax, below); a lawyer's review of both drafts; the #47 referral-fingerprint line before
  `FEATURE_REFERRALS` goes on; how to honour a waitlist / Growth removal request (the policy says
  "ask us and we'll delete it", and there is no admin tool — done by hand in the database).
- **Growth cross-sell rule (Check 5 P1, 2026-10-17):** the app may mention Growth only with static
  text that is the same for every owner (no props, no counts, no conditions on mail, drafts,
  quotes, money owed or activity). No Growth mention on /billing, read-only or expired screens, or
  in lifecycle, digest, monthly-summary, alert or text-message content. No app data is ever copied
  into a Growth lead. The one allowed line is `GrowthMention` (`src/components/app/growth-mention.tsx`,
  no props, copy `growthCopy.appMention`), placed on the More screen only and hidden there for
  read-only or expired accounts (`jobsAllowed`).
- **Growth code may not import inbox modules or tables (Check 2 P5):** no `@/mailbox`, `@/ai`,
  `@/jobs`, sync / classification / inbox / drafts / voice / quotes / customers / followups / digest,
  and no threads, messages, drafts, mailboxes, voice or business profile, usage or activity log
  tables. `tests/unit/growth-boundary.test.ts` enforces both rules; a new Growth file (like the
  client portal) is added to its `GROWTH_PATHS` / `MENTIONS` lists on purpose, with a reason.
- **Growth client portal (2026-10-16, branch `growth-portal`):** migration `0038_growth` (0035 on its branch)
  (additive; renumbered at merge): `growth_clients` (one per workspace, cascade; status active |
  paused | ended; `started_on` date; `services` text[] of `GROWTH_SERVICES` ids; `time_zone`,
  set by Davi, Eastern default), `growth_updates` (title ≤80, body ≤2000, Davi's words;
  `notified_at`), `growth_monthly` (unique client + 'YYYY-MM'; optional new_leads, calls,
  jobs_won, money_won_cents, reviews_gained, ad_spend_cents; note ≤280), and on `invites`
  `growth_invited_at` / `growth_services` / `growth_started_on`. Rules in
  `src/server/growth-client-rules.ts` (pure), DB in `src/server/growth-clients.ts`.
  - **Growth never uses inbox data (Davi's review, Check 5 P1 / Check 2 P5):** every dashboard
    number is one Davi entered in `growth_monthly`, labelled "From your monthly check-in(s) with
    Davi"; the money line is "Money from jobs you won since Growth started (as you told Davi)".
    Growth files never import mailbox / ai / jobs / sync / inbox / drafts / voice / quotes /
    customers / followups / digest code, nor the threads, messages, drafts, mailboxes,
    voice/business profile, usage or activity tables (`growth-portal.test.ts`); the client's
    months use `growth_clients.time_zone`, never `business_profile.time_zone`. /admin's Growth
    card shows only what Davi entered. Nothing goes to the AI.
  - **Sign-in lands on `/start`** (the sign-in action, `/signin` and `/` for a signed-in
    owner): an active or paused client picks "My inbox · Squared Away" (/queue, which shows
    Connect Gmail when none is connected) or "My Growth dashboard" (`/my-growth`; not `/g` —
    robots' `Disallow: /g` would also block `/growth`). Everyone else is redirected to /queue.
    Both are outside `(app)` (own header, no tab bar), in the proxy matcher and robots, behind
    `requireOwner` (terms). `/my-growth` 404s for non-clients and ended clients (no
    loading.tsx; in the C2 must-404 list).
  - **Admin "Growth clients"** on its own page `/admin/growth` (/admin only links to it with a
    count: with every client's forms inline, /admin got slow enough under load to time out older
    admin e2e tests). `admin/growth-admin.tsx`, actions in `admin/growth-actions.ts`, all
    `requireAdmin` first; `growth_*` notices on /admin/growth, `wl_*` in /admin's waitlist card: Start Growth for this account (accounts listed as business name +
    owner email; a client whose Growth ended can be started again), change services / start date
    / time zone, pause / resume / end (confirm each), Post an update, Monthly numbers (one form per
    month; emptying every box removes the month), Invite to Growth (no account yet).
  - **Invite to Growth** (also on a waitlist card's Growth request, services pre-ticked from the
    request): an invite row (sign-in gate) with the Growth fields; refused for an address with an
    account. `ensureUserAndWorkspace` → `linkGrowthInvite` makes the client once and clears the
    fields (never fails sign-in). No trial: the clock still starts only at Gmail connect. Email
    "Your Squared Away Growth dashboard" once per invite (`growth-invite-email:<hmac>-<time>`).
  - **Update email** "New update from Squared Away Growth": the title + a link only, Resend key
    `growth-update-<workspace>-<update>`, `notified_at` set only after Resend took it; off without
    Resend; "Email it to them" retries an unsent one.
  - **Remove** on a waitlist card's Growth request (confirm step): a growth-only row is deleted; a
    mixed row keeps the app sign-up and loses only the Growth block (`withoutGrowthBlocks`).
    Decided on the row as it is at the tap. Log `growth_request_removed {result}`.
  - **Pledge** `growthCopy.pledge` (GrowthChapter, so /growth and the homepage half; the dashboard
    too): names `GROWTH_OWNED` for every service (copy test), "We never take a percentage of
    your jobs or your business." The in-app mention is `GrowthMention` (no props, static
    `growthCopy.appMention`), More screen only, hidden on read-only or expired accounts; clients also get a
    "Growth" row to `/my-growth` there.
  - Docs: `docs/growth-agreement.md` (draft, not legal advice, [To confirm] items), privacy-policy
    Growth-client lines (same 2026-10-16 date, kept at the integration),
    LAUNCH.md step 13. **Referrals:** built 2026-10-17 at `startGrowth` / `linkGrowthInvite` (see
    #47's Growth door).
