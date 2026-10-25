# Admin and ops: /admin, rate limits, error alerts, security, plans, and the merge and integration records

Moved unchanged from `CLAUDE.md`'s "Decisions" section on 2026-10-19 (Check 49 P5), in their
original order. Rules that a test or gate depends on are also stated in `CLAUDE.md`.

- `/admin` (`requireAdmin` → 404 for anyone but `ADMIN_EMAIL`; actions re-check). Shows per-workspace
  status, plan, evaluation end, mailbox health, draft counts, AI calls/cost — selects no thread,
  message or draft text and no customer addresses (tested). Manual moves until Stripe (M10):
  extend 3 days, mark setup paid (turns sending on), setup call done (→ active), pause/resume
  (`ADMIN_MOVES` table; resume returns to where it was). Also an invite form. Link in Settings → Account
  for the admin only.
- **Rate limits (2026-10-06):** `src/server/rate-limit.ts`, fixed windows in the `rate_limits` table
  (one atomic upsert; holds across serverless instances). Per workspace: send 60/10 min (action +
  API → 429 with Retry-After), Draft a reply 90/h (counted at the model call, Check 40 P3),
  re-learn voice 3/day, billing 10/h, Gmail connect
  10/h. Waitlist 10/h per **hashed** IP (salted with AUTH_SECRET; raw IPs never stored). Webhooks
  are signature/token-checked instead. Purged daily with bodies. e2e global setup clears the table.
  **M11 (S4):** `poll` 300/10 min on `/api/badge` and `/api/push/summary` (429 + Retry-After,
  no-store; phones ask ≤1/min) and `gmailWrite` 120/10 min on save-edit and discard
  (`?error=busy`). No window may exceed a day (`MAX_WINDOW_SEC`; the purge drops 2-day-old rows).
- **Error alerts (2026-10-06):** `@sentry/nextjs`, off unless `NEXT_PUBLIC_SENTRY_DSN` is set.
  `src/instrumentation.ts` (server init + `onRequestError`), `src/instrumentation-client.ts` (SDK
  loaded lazily only with a DSN), Inngest middleware `ReportFinalFailures` (final attempt only, then
  flush). `scrubEvent` drops request data/cookies/headers/query, keeps only user id, masks emails,
  drops console breadcrumbs and `extra`. Errors only (tracesSampleRate 0, no replay). No
  `withSentryConfig` / source-map upload (keeps the build free of a Sentry auth token).
- **Feature plan:** `docs/FEATURE-PLAN.md` (Davi's picks from 50 ideas, 2026-10-09) is the spec for
  work beyond the brief, filed by milestone. 1:1 calls package, app-store listings: later (Davi).
  Calendar booking: after Google approves Gmail access.
- Davi's direction (2026-10-05): keep features simple; make it faster, smoother, more reliable.
  Open idea, **his decision, don't build yet**: hands-on 1:1 business calls/reviews as part of a
  package (setup call already in the $499 setup).
- **Launch merge (2026-10-13, branch `claude/launch-integration`):** M5–M8 + #47 and PR #9 + Growth
  in one tree. Referrals and Growth share the waitlist: the code is stored only while
  `referralsVisible()` (flag on AND a reward); a Growth request stores one too since 2026-10-17
  (see #47's Growth door); an app join that upgrades a growth-only row stores its code (if
  visible and none was kept) and takes the app
  form's trade (required there, and it is what the invite uses); a different Growth trade stays in
  the block as "Trade given" (`withBlockTradeGiven`). robots.txt also disallows `/money` and
  `/record`. `inviteFromWaitlist`
  refuses growth-only rows (`growth_only`) before looking at any referral, then carries
  `referredByWorkspaceId` only while visible. /admin's "Came from a referral link" sits on the
  Growth-aware `WaitlistEntry` card (app sign-ups only, visible only). The homepage keeps
  `ForgetOffline` and Growth's opaque header (no backdrop blur). theme.css holds sunlight mode
  (#37) and the Growth switch / `.sa-light` / `/growth` background side by side (the flip was
  replaced by the scroll switch, merged 2026-10-14; see "Merged into claude/launch-integration").
- **Outside-review follow-ups (2026-10-16, after verifying P1–P4):**
  - Reply-To backfill matches only the **one email a draft answers** (`answeredIdSql`: the
    inbound row it's threaded to, else the newest real non-side inbound before the draft was
    made); an older email's Reply-To never moves a draft or flags a past send. Re-point writes
    the **row first** (conditional), then Gmail; a Gmail failure puts the row back (and
    un-queues a tap made meanwhile).
  - `reply_went_to_form` detail carries `robot` (`looksLikeFormSender`: no-reply, known form
    hosts, wordpress@/forms@…). `robot: false` (a person naming their other address) reads
    "…went to the address their email came from… Check they got it." — never "send it again".
    REPOINTED_FLAG / `draft_repointed` / the Autopilot settings line are worded neutrally
    ("the reply address the customer's email named").
  - **Send checks the To the owner saw:** the card (and offline okays, `Intent.seenTo`) post
    `seenTo`; `queueSend` refuses `to_changed` (`?error=to_changed`, 409 on the API) when the
    draft now goes elsewhere, and its queue write requires the To it loaded.
  - `threadsToAutoDraft` leaves out threads whose newest inbound has a **checked** no-reply
    reply address (unchecked NULL stays in), so skipped robots can't starve real leads.
  - Inbox: only noise that doesn't need the owner folds into "N junk emails"
    (`isFoldableJunk`); needs-owner noise keeps its "Waiting on you"/"Replied" word.
  - AutoSaveForm: a radio saves at once only after a pointer tap (`isPointerChange`, 1.5s);
    an arrow-key change shows the Save button instead (WCAG 3.2.2).
  - Homepage: "Two nudges at most per conversation — each one a draft that waits for your
    okay." (the cap counts nudges sent); the queue still's card and caption say nothing goes
    to a customer during the three days. In-app `sendingOffLabel` unchanged (pinned).
- **M11 security audit (S4, 2026-10-13):** static tests guard the surface —
  `tests/unit/security-surface.test.ts` (C1 every server action awaits `requireOwner` /
  `requireAdmin` first, reviewed public/inline allow-lists; C2 admin pages + no `loading.tsx` over
  must-404 screens; C3 every route handler in a table with its guard, a new route fails, and no
  `src/pages`, root `app/` or root `pages/` may exist (the table covers src/app only); C4 every
  navigation sink — server: `redirect` / `permanentRedirect` (also renamed), any `.redirect(…)`,
  Auth.js `redirectTo`, a Location header in any case (object key, string / computed key,
  shorthand, `[name, value]` pair, `new Headers(…)`, `.set` / `.append`; outside a `headers:`
  value or `new Headers(…)` a plain string literal is let through, e.g. site.ts's place name);
  client: `push` / `replace` on a `useRouter()` router (or one named `router`),
  `location.assign` / `.replace`, `window.open`, and assigning `location` / `window.location` /
  `document.location` or their `href` / `host` / `hostname` / `protocol` — takes a visible own
  path (`"/x…"`, a template or concat starting `/x`, our imported `appUrl` of one, a `const` /
  helper / non-exported top-level helper parameter whose every call passes one and that is never
  written to), else it must be in the reviewed list (Stripe URLs, Google consent, the profile
  `returnTo` enum); names are resolved with TypeScript's binder (`bindFiles` in
  `tests/support/source-ast.ts`), so a for-of / catch / hoisted `var` / inner helper of the same
  name can't borrow an outer const's verdict; plus the old redirect-target param-name check). Not
  covered: link `href`s and a computed key held in a variable. The scans read
  .js/.jsx/.mjs/.cjs as well as TS (`allowJs`; Next serves JS routes), and src/app must hold no JS
  file (M11 review findings 3–4). Also
  `tests/unit/no-content-logs.test.ts` (C11). Fixes: the send API answers 403 for an
  unparseable Origin (was a 500); `sendPush` re-checks the push-endpoint allow-list
  (`src/lib/push-endpoint.ts`) and never fetches anything else (returns `gone`); HSTS
  `max-age=31536000` (no includeSubDomains/preload); Connect Stripe failures travel as fixed
  codes (`src/server/stripe-error-rules.ts`) and /admin shows our sentence, never Stripe's text.
  **C9 accepted as the UI behaves today:** read-only accounts may still snooze and tap "This one
  needs me" (both only reorder the owner's own list; no Gmail or model call; tested).
  Verified, no change: push endpoint re-homing on upsert, the Gmail push `?token=`, the health
  commit SHA, CSP `'unsafe-inline'`, JWT-trusted admin email, `x-forwarded-for` on Vercel.
- **Milestone 11 summary (2026-10-13, branch `claude/launch-integration`, not deployed):**
  - **e2e seams (S1/S2):** `src/config/e2e.ts` is the only reader of `SA_E2E*`. `e2eMode()` is on
    only when `SA_E2E === "1"`, `VERCEL`/`VERCEL_ENV` are unset, both `SA_E2E_GOOGLE_BASE_URL` and
    `SA_E2E_ANTHROPIC_BASE_URL` are set with an http(s) hostname of exactly localhost / 127.0.0.1
    / [::1], and `DATABASE_URL` is loopback or a unix socket (`isLocalDatabaseUrl`, read the way
    postgres.js reads it: a comma, a second `@` or a `#` in the raw host part is refused, since
    postgres.js cuts at the first `@`; `PGHOST` checked when it names no host). Otherwise
    `googleEndpoints()` / Anthropic options are the real ones and `e2eHookSecret()` is null.
    `/api/test-hooks/run` (POST; backfill, sync, voice, classify, draft, deliver through the
    same functions the jobs call) is 404 unless e2e mode and a ≥32-char secret (constant-time);
    errors return `err.name` only. No request-host check: under `next start`, request.url is
    the server's own listen hostname, so it could never refuse. Instead playwright.config.ts
    starts the app with `--hostname localhost` (an e2e spec proves the network addresses are
    refused). Smoke runs (`PLAYWRIGHT_BASE_URL`) open no database: the global setup returns
    first and only `tests/e2e/smoke-specs.ts` run (smoke + `security-public.spec.ts`: headers and
    the hook's 404, Playwright-only imports); `tests/e2e/support.ts` throws at import on a
    non-local `DATABASE_URL` (`tests/unit/e2e-harness.test.ts`). Fakes in
    `tests/e2e/fakes` (loopback only, record no secrets, Gmail-faithful drafts/history).
    `tests/e2e/full-flow.spec.ts` is the whole owner journey (paid: connect → backfill → voice →
    classify → draft → sync → Send reply → exactly one threaded `drafts/send` → Delete my account
    → one revoke, no rows; trial: 403 + practice copy to self only), and its steps map to the
    demo-video script in `docs/google-verification.md` (tested).
  - **Purge and deletion (S3):** see the M11 notes under the retention purge and Delete my account
    above (draft flags, extracted free text, cleared send timers; invite + cost/email markers in
    one transaction; waitlist kept). `tests/unit/data-lifecycle.test.ts` is the gate.
  - **Security (S4):** see "M11 security audit" above (HSTS, `poll` / `gmailWrite` limits,
    `sendPush` allow-list re-check, Origin parsing → 403, read-only gates as the UI behaves,
    Stripe error codes, static surface tests incl. C15: every Sentry path goes through
    `scrubEvent`; no "send a test error" button on purpose).
  - **Docs (S5–S7):** legal drafts (above); `docs/google-verification.md` + `docs/SETUP.md`
    (every env var the code reads, `tests/unit/env-docs.test.ts`; verification facts and the
    demo-script mapping, `tests/unit/verification-doc.test.ts`); **`docs/LAUNCH.md`**, Davi's
    plain-words launch checklist (Google verification first, merge, preview database, secret
    rotation, env per environment, domain, Resend, Stripe live, Sentry, VAPID, Twilio/Pub/Sub,
    Inngest check, smoke test, every open decision). `tests/unit/launch-doc.test.ts`: no
    secret-looking value in any doc (also CLAUDE.md, AGENTS.md, .env.example), links and anchors
    resolve, every setting SETUP.md marks required is in its table, and the screens, setting keys
    and job names it tells Davi to look for exist in the code. Keep LAUNCH.md in step with the
    code: a renamed screen line or job fails that test.
- **Davi's decisions, 2026-10-14** (all in `docs/LAUNCH.md`: the "Decided" and "Still open"
  parts of step 13; research with sources was gathered that day, facts marked unconfirmed are
  worded as such in the docs):
  - **Merge: okay.** The engineers open the pull request `claude/launch-integration` → `main`
    once CI and the preview are green; Davi presses Merge (the production deploy). Nobody else
    merges.
  - **Preview database: option B**, a separate, empty Neon project `sa-preview` in the same Neon
    organization and region as production, Postgres service only. Option A (Neon branch copies of
    production) is gone from LAUNCH.md step 2; the "how to split a setting" explanation, the
    shared-entry warnings, the branch-address sign-in notes and the optional preview Google
    client stay. Division of work: Davi creates the project, opens Connect with "Connection
    pooling" on, copies the pooled string (host contains `-pooler`) and tells the engineers; the
    engineers untick Preview on the existing `DATABASE_URL` entry through the Vercel API (a
    target-only edit; production's value is never sent or touched); Davi adds `DATABASE_URL` as a
    new **Secret** with only Preview ticked and pastes the string; the engineers add Preview-only
    `AUTH_SECRET` and `TOKEN_ENCRYPTION_KEY` (fresh random values, same split) and redeploy the
    preview, whose `vercel-build` migrates the empty project (build log "Migrations applied.").
    Worked when: the preview's `/admin` shows "Accounts (1)" after Davi signs in at the branch
    address, and production's `/admin` is unchanged. Why not a second database in the production
    project: same host and compute (and, on Free, the same 100 CU-hours), and every role made in
    Neon's console joins `neon_superuser` (can read and write production). Background jobs need no
    change: every id a job event carries is a random UUID, so a stray preview event can't match a
    production row (previews are behind Vercel login anyway). **Not checked live:** Neon's console
    strings end `&channel_binding=require`, postgres.js 3.4.9 forwards unknown URL parameters as
    startup parameters and Neon's pooler accepts only a few; production's string (saved
    2026-09-28) works, so it's probably fine. If the first preview build fails with
    `Migration failed` mentioning `channel_binding` / an unsupported startup parameter, drop that
    parameter from the Preview value. `ANTHROPIC_API_KEY` and `AUTH_GOOGLE_SECRET` are still
    shared prod+preview Secrets (metadata checked 2026-10-14). Cost: $0 on Neon Free (own 100
    CU-hours, 1 GB); cents a month on Launch (estimate).
  - **Neon plan (new, urgent, Davi's money decision):** `poll-mailboxes` (every 5 min),
    `workspace-lifecycle` (15 min) and `morning-digest` (hourly) query the database, and Neon only
    suspends a compute after 5 idle minutes, so production rarely sleeps: about 180 CU-hours a
    30-day month at 0.25 CU (more if it autoscales) against Free's 100 per project, so on Free it
    would likely be suspended around day 16–17 of each billing period. Launch = $0.106/CU-hour,
    about $19–20 a month for that compute (estimate from Neon's prices). Production's plan isn't
    visible to the engineers. LAUNCH.md "Check your free plans now (this week)", before step 0.
  - **Test-mode Stripe accounts: reset them** with the built `/admin` → Payments → Reset test
    payments after the live key swap and Connect Stripe (LAUNCH.md 7c; see "Reset test
    payments" above).
  - **Sales tax: Stripe Tax on** (built; see "Stripe Tax" above). LAUNCH.md 7e is now the whole
    job: register with Massachusetts first on MassTaxConnect (Davi is in Concord; Stripe can't
    register an in-state seller; SSN for a sole owner with no employees, else EIN; free and about
    3–10 business days per third-party guides, not confirmed on mass.gov), then Stripe → Settings
    → Tax: head office = the Concord address, preset code `txcd_10103001` (SaaS - business use),
    Include tax in prices = Exclusive; the setup product `txcd_20120002` (SaaS Implementation and
    Setup Services - Mandatory) unless the accountant says otherwise; Tax → **Locations** → Add
    registration → Massachusetts → I've already registered. Stripe's docs call that page
    Locations (its URL ends `/tax/registrations`); `SALES_TAX_ON_NOTE` still says "Tax →
    Registrations" (not changed here; the docs bridge it). Without the Massachusetts
    registration Stripe charges $0 tax and warns about nothing (its threshold alerts never cover
    the home state). The portal section is "Billing information" (not "Customer information").
    Tax Basic = 0.5% of each taxed payment, no monthly fee, no filing: Davi files on
    MassTaxConnect from Stripe's report (state sets the frequency; each return due within 30 days
    after its period). Accountant questions are listed once, in 7e.
  - **Terms: still open** (Davi reads later). Recommended option A for each of the three
    `[To confirm]` items (refunds: cancel any time, no partial months, setup fee refundable only
    before the setup call, Delete my account ends the plan with no refund for the rest of the
    month; liability: mutual cap at the greater of $100 or 12 months' fees, carve-outs; law:
    Massachusetts, 30-day contact-first step, Middlesex County state courts or D. Mass., small
    claims allowed, no arbitration). New open question: assent. Stripe Checkout
    `consent_collection.terms_of_service = "required"` (terms URL in Stripe's public details) and
    an "I agree" checkbox at sign-in for trial users (Kauders v. Uber 2021, Good v. Uber 2024):
    code changes that need Davi's yes (yes on 2026-10-15, built: "I agree" boxes below). Lawyer review about $750–$2,500 (Boston Bar referral: 30
    minutes for $25 at most); questions on an LLC, insurance and "no contract". `docs/terms.md`
    wording is unchanged.
  - **Google review: both questions decided 2026-10-15** ((a) option B; (b) `gmail.send`
    dropped and built; both below).
    (a) Demo account: option A (house account with
    the demo Gmail swapped in, as google-verification.md describes) or **option B** (new: a
    separate demo account invited from `/admin`, paid with Stripe's test card while production
    Stripe is in test mode so `setup_paid_via = 'stripe'` lets it send; nothing of Davi's touched;
    delete it before step 7 or let Reset test payments clear it in 7c — the button only exists
    with the live key — after which it can't send, so a re-recording of a send needs option A or
    a real card; needs an engineer's dry run on **production** first with the demo Gmail while
    Stripe is in test mode). (b) Drop `gmail.send` (decided yes 2026-10-15, built; see "Gmail
    scopes: two" below): recommended yes (`users.drafts.send`
    accepts only mail.google.com / gmail.modify / gmail.compose; `users.messages.send` also takes
    gmail.compose; doesn't avoid CASA; small change, no reconnect since `mailboxes.scopes` is
    never read after connect; not tried live: checked on production with the demo Gmail right
    after it ships — the demo Gmail's old grant cleared first, then a practice copy, then a
    test-card payment and a real reply — and reverted at once if either fails). **A preview
    can't run either check** (2026-10-15 review): after the split no background job reaches a
    preview's database (Inngest only reaches production; previews sit behind Vercel login) and
    `STRIPE_SECRET_KEY` is Production-only, so a preview never syncs, drafts, takes a payment or
    delivers a queued send. CASA facts now in LAUNCH.md 0g and
    google-verification.md: AL1/AL2 chosen by Google, TAC Security $675/$855 (AL1) and $5,400
    (AL2), budget about $700–$1,000/yr (AL1) or $4,500–$5,400+ (AL2), don't pay until Google's
    email names the level, two quotes, 2–6 weeks lab, 1–3 months whole review, renews every 12
    months. The unverified app's 100-new-user cap is for the project's lifetime (can't be reset):
    keep sign-up invite-only.
  - **#47 referral reward: decided** (2026-10-15 offer A; answers 2026-10-16). Built behind
    the switch; see the #47 entry above.
  - **#26 closing question: on** (see Plan M7 above). The env var stays the switch; no code
    default change. The privacy policy ("How we use it"; dated October 15, 2026 with the terms)
    and google-verification.md (where email content goes, the notes bullet, the autopilot list)
    name it since the 2026-10-15 review.
  - **Growth:** Davi confirmed all seven services and the ground rules. Still open: a written
    agreement (Growth terms), a Settings link to `/growth`, an admin Remove button (waitlist /
    Growth removals are by hand today). A Growth request carrying a referral: yes (2026-10-16).
  - **Homepage:** "Big words", replaying every time (scroll into Growth and every tap on a
    `#growth` link from the app side). Built on `claude/growth-page`, merged into this branch; the
    details are under "Squared Away Growth" above.
- **Leads + ideas merge (2026-10-16, `ideas-build` ← `leads-build`):** leads' `0032_leads` reaches
  the shared database first (PR #13's previews run it), and drizzle's migrator only applies a
  migration whose journal `when` is later than the last applied one, so the ideas migrations were
  renumbered after it: `0033_control` (when 1792192470911) and `0034_numbers` (when
  1792192476806; leads' 0032 is 1792180535102), regenerated with drizzle-kit (same SQL) so the
  snapshots chain 0032_leads → 0033 → 0034. `tests/unit/migrations-order.test.ts`
  fails if any journal `when` doesn't strictly increase in idx order (or tags/files disagree).
  Combined behaviour: `OWNER_RULE_KEYS` gains `sender_rule` (a company "Always needs me"), so
  "Add <town>" only clears needs-you when the town was the one reason; the junk-by-rule shortcut
  never fires for voicemail / text-message emails (they are always read, like the Promotions
  shortcut); `companyChoice` refuses email-to-text gateways ("Anyone at vtext.com" would be
  many people); `createDraftForThread` keeps every refusal from both sides (lead_site /
  phone_message first, then the jobs-only owner_moved / sender_rule / away, then text_address /
  maybe_text_address on the final address); autopilot refuses owner-moved kinds, lead channels and
  phone-like addresses. `NeedsYouCard` takes the private note line and the Move it sheet (not on
  check-ins or read-only accounts); draft cards show the lead lines then the note. Quote speed
  (C8) reads the same request query as response time, so it leaves lead-channel threads out too.
- **Integration (2026-10-17, branch `integrate-3` on `wave0`):** decisions, replies and
  growth-portal merged with `--no-ff` in that order.
  - **Migrations:** wave0 keeps `0035_reserved_columns`; the packages' 0035s were regenerated
    with drizzle-kit on top of it as `0036_decisions` (when 1792207285776), `0037_replies`
    (1792207482652) and `0038_growth` (1792208657111), SQL byte-identical to the originals.
    Applied on a scratch database on top of main's journal: 39 rows, nothing skipped.
  - **Emergency voicemails alert (lead engineer's decision):** an emergency-lane email from a
    phone service (Google Voice's voice-noreply@google.com, an email-to-text gateway) alerts the
    owner's phone even though its From is no-reply; every other no-reply sender still never
    alerts. The alert goes only to the owner's own push endpoints and verified number; the
    caller gets nothing (lead-channel threads are never drafted). Test in
    `emergency-alerts.test.ts`, plus a parity test of `phoneMessageSenderSql` against `channelOf`.
  - **Paused drafts aren't counted:** `QueueMember.paused` marks members on a plan-paused Gmail
    address; `actionableQueue` / `countQueue` leave them out, so the morning email (replies,
    nudges, needs-you), the badge, the phone's notification, the banner and the trial emails
    never count what the owner can't act on. The queue screen still shows them, marked paused
    (read-only card, no Send reply, no Other ways to reply).
    The morning email's money totals hold no drafts (won quotes and invoices, the same as Money
    and Activity), so the pause doesn't change them. Trial emails need a connected address the
    plan covers (`notPlanPaused()`); emergency alerts use `mailboxRunning()`. Static checks in
    `mailbox-plan.test.ts`.
  - The Growth boundary test lists the portal's files with reasons, and server imports of the
    portal modules are allow-listed (`accounts.ts` for `linkGrowthInvite`). `admin-no-content`
    covers /admin/growth's readers. The terms and privacy policy took clarifications only (trial
    emails, plan pause, emergency voicemails, alerts as a convenience, Growth as a separate
    service); the date stays 2026-10-16 with `TERMS_VERSION` (re-agree is Davi's call, LAUNCH.md).
- **Wave 1 integration (2026-10-17, branch `integrate-w1` on `claude/squared-away-mvp-ddxl7s`):**
  `wave1-send`, `wave1-checks`, `wave1-home`, `wave1-safety` and `wave1-break` merged with
  `--no-ff` in that order.
  - **Migrations:** one chain after 0038 in merge order: `0039_send_path_sent_via` (when
    1792258162358), `0040_send_path_autopilot_claim` (1792258870232), `0041_licenses`
    (1792271229521; `0039_licenses` on its branch, regenerated with drizzle-kit on top of 0040, SQL
    byte-identical). Applied on a scratch database on top of main's journal: 42 rows, nothing
    skipped. The referral branch takes the numbers after these.
  - **Prompts:** `draft.v8` (Draft checks: Check 38 P6 licenses line, Check 40 P1 deductible, Check
    41 P1 safety), `voice.v3` (Check 23 P7 typed blanks), new kind `dispute-caution.v1` (Check 43
    P9). A dispute / legal draft stores `draft.v8+dispute-caution.v1` (a tweak
    `revise.v2+dispute-caution.v1`); `dispute-caution.test.ts` pins it to `ACTIVE.draft`.
  - **Edit box and blanks:** the Edit box's word swap (Check 9 P4: `{{time}}` shows as `[time]`)
    swaps only typed gaps; a `[name]`-style blank (Check 23 P7) shows as written, goes back
    unchanged, and is named in "Fill in [name] first" (`src/ai/gaps.ts`, test in
    `gmail-hiccups.test.ts`). The Queue's gap notice lives in `queue-messages.ts`: "Fill in every
    blank before sending. Nothing was sent."
  - **Merge of `wave1-safety` (same day, after the three above):** no migration. One `draft.v8`
    holds both groups' marked lines (Draft checks: Check 38 P6 / 40 P1 / 41 P1; Safety guards:
    Check 48 P1 "Who is writing"); `classify.v5` is Safety's (Check 22 P4 + 36 P1, 22 P3, 48 P1,
    22 P5). Safety notes keep their own versions (`safety-note.v1`, `safety-note-co.v1`,
    `safety-note-electrical.v1`) and never get the dispute caution. In `classifyPending` the
    code-only path after the AI limit (Check 39 P1) runs first and the change-order rule (Check
    38 P1) and quote acceptance run only on a model result. The business profile form has both
    the licenses group / MA deposit line and the remodeler's amount suggestions (the amount input
    is the controlled one). Privacy policy gained the safety-marks line (date unchanged).
    classify.v5's `co_alarm` is `z.boolean().catch(false)`; evals gained `coAlarmRecall`,
    `electricalHazardRecall` (strict) and `gasFalseAlarms` (no increase allowed). Evals not run.
  - **Merge of `wave1-break` (same day, last):** migrations `0042_paused_from` (when 1792276181035) and `0043_fallback_calls` (1792276182158), `0039_paused_from` /
    `0040_fallback_calls` on the branch, regenerated one at a time with drizzle-kit on top of
    0041 (SQL byte-identical). No prompt change. Three fence tests changed on purpose by the
    branch: `data-paths` checks `messages.create` (Check 29 P1 parses the answer itself; same
    single request, same data path), `e2e-mode` accepts `...anthropicClientOptions()` spread
    last (e2e mode still wins), `security-surface` has the new "shared-secret" route guard.
    `reviseDraft` takes both `openedHash` (Check 42 P2) and `aiMode` (Check 48 P4).
    **Integrator fix (missing model names the part):** `src/server/model-alert-rules.ts` (pure):
    `MODEL_PART` (classify → Sorting, draft → Drafting, voice → Voice learning),
    `stoppedHeading`, `modelDownEmail`, `modelDownLine`. `recordModelDown(role, model, now)`
    writes `model_down:<role>:<model>:<UTC day>` and emails once per role and model per day
    (`model_alert:<role>:<model>:<day>`), because drafting and voice share one model. The email
    says "Drafting is stopped: … Owners' replies are waiting to be drafted." (and so on);
    /admin's System box heading is "Sorting is stopped" / "Drafting is stopped" / "Voice
    learning is stopped" (several: "Drafting and voice learning are stopped") and each line
    starts with its part. Tests in `ai-client.test.ts`.
  - **Send path (wave 1, group "Send path"):**
    - **Check 9 P1 (seen text):** every Send reply (card, Edit box) posts `seen` = `bodyHash` of the
      text the card showed; the review page posts `seen:<draftId>` / `seenTo:<draftId>` per row.
      `queueSend({ seenHash })` returns `changed_since_seen` when the stored text differs, and the
      queue write itself only lands while `drafts.body` is still the text that was checked. The
      server action refuses a tap with no fingerprint (an old page) the same way; the JSON route
      takes an optional `seen` for online sends (409 `changed_since_seen`). Notice:
      "That draft changed since you opened it, so nothing was sent. Here's the latest version. Read
      it, then tap Send reply again."
    - **Check 42 P1 (answered from Gmail):** `answeredSince(threadId, since, mailboxEmail)`
      (`src/server/drafts.ts`): an email from the shop on the thread after the draft was written,
      not an unsent Gmail draft, not a practice copy (To/Cc only the mailbox's own address) and
      **not a side conversation** (`sideEmailSql`: a forward to the crew is no answer; the spec
      didn't say, but without it a forward to the crew would set the reply aside). queueSend and
      sendDraft return `answered_elsewhere` (with when) before any Gmail call; the Queue shows "This
      was already answered from Gmail at 2:14pm. Nothing was sent." with "Open the conversation in
      Gmail" (no Send anyway). reconcileDrafts sets a waiting reply aside (expired, Gmail draft
      deleted, note "Someone answered this from Gmail, so this reply was set aside.") after the
      customer-wrote-again and the Gmail-draft-gone branches. A send in its undo window is closed
      the same way by deliverQueuedSend, which logs `send_stood_down` {draftId, reason} (Activity:
      "Didn't send the reply to Dana: someone had already answered from Gmail") instead of
      `send_stopped`. Autopilot unchanged (its own newer-mail check runs first).
    - **Check 14 P1 (`drafts.sent_via`, migration `0039_send_path_sent_via`, additive):** app /
      autopilot / gmail / own_words; null = older rows, counted as before. Reconcile with our Gmail
      draft gone and a newer shop email: our message id or the same text (`prepareBody` +
      `sameText`) → `gmail` (`edited_and_sent` when the id matched but the text differs); otherwise
      `own_words` with status still `sent` (two-nudge cap unchanged), Activity
      `owner_wrote_own_reply` "You answered Dana yourself in Gmail" (no See record). decidedAt =
      that email's time. own_words is left out of monthSummary, the weekly scorecard's sent count,
      monthMoney's "paid after a follow-up" and the digest's "sent yesterday".
    - **Check 9 P2 (honest Hold it; migration `0040_send_path_autopilot_claim`, additive):**
      `drafts.auto_send_claimed_at`. `runAutopilotSend` claims the draft in one conditional UPDATE
      (pending, countdown due, unclaimed or claim older than `AUTOPILOT_CLAIM_LEASE_MS` = 2 min)
      before any Gmail call; only the claimer goes on, and the claim is released when it stands
      down, fails or throws. `sendDraft(by: "autopilot")` sends only a draft that is still counting
      down **and** claimed (an edit, hold or plan change that cleared the countdown wins);
      `queueSend` answers `already_sending` while a live autopilot claim holds it.
      `holdAutopilot` → `{status: "held"} | {status: "too_late", sent} | {status: "not_found"}`;
      "Held." only for a draft that did not go; too late → "Too late, autopilot already sent it.
      See it on Activity." (+ See record) or "Too late to hold: autopilot is sending it right now."
      The card shows a live countdown (`autopilot-countdown.tsx`: "Sends in 6 min", seconds in the
      last minute; the clock time once for screen readers) and refreshes every 4 s for a minute at
      zero.
    - **Check 42 P2 (never overwrite Gmail's text):** `saveDraftEdit` and `reviseDraft` read the
      Gmail draft first (reviseDraft before the model is called, and again before it writes): a
      different text there becomes the draft's (`takeGmailText`, countdown and queued send
      cleared) and they return `changed_in_gmail` without writing to Gmail. Both take an
      `openedHash` (the Edit box posts `opened`, the quick-change forms post `seen`): a stored text
      that moved on since → `changed_since_opened`, no Gmail call, no model call. The Edit box is
      now `draft-editor.tsx` with `editorAction` (useActionState; `saveDraftEditAction` is gone):
      it answers inside the card, puts the newest text in the box and keeps what was typed in a
      read-only "Your text" box. Quick changes redirect to `?error=changed_editing`.
    - **Check 8 P1 (no signal):** `NoSignalGuard` (`src/components/app/no-signal-guard.tsx`, once in
      the (app) layout) stops any form submit while `navigator.onLine` is false — a capture
      listener on `window`, ahead of React's own on `document` — unless the form is inside
      `[data-offline-ok]` (only the card's Send reply, and only with offline okays on). Strip above
      the tab bar: "No signal. Nothing was sent or changed. Try again when you have a bar."
      (role=alert, inverted), and a quieter "No signal right now." whenever offline. New
      `src/app/(app)/error.tsx` keeps the header and tab bar; offline or a failed request (a
      `TypeError`) says "We couldn't reach Squared Away. If this was a reply, open the Queue when
      you have signal: if the card is still there, it wasn't sent." Send reply shows "Still trying.
      Weak signal. Don't close the app." after 12 s (`send-button.tsx`, words only). Typed text is
      kept per tab in sessionStorage (`src/lib/kept-text.ts`, fingerprinted by what the screen
      showed so a stale copy is dropped once the save went through): the Edit box (key per draft;
      the card reopens the editor on reload) and the business profile form (`use-kept-form.ts`).
    - **Check 9 P3 (Gmail hiccups):** queueSend, saveDraftEdit, reviseDraft and discardDraft return
      `gmail_busy` (MailboxRateLimitError) or `gmail_failed` (anything else Gmail threw) instead of
      throwing; logged as `<where>_gmail_failed` {draftId, kind, error name}. Queue notices:
      `gmail_failed` "Gmail didn't answer, so nothing was sent. Try again in a minute.", and every
      notice a Send reply tap can reach now says whether anything was sent (unit test pins it).
      The Queue's notice words moved to `src/app/(app)/queue/queue-messages.ts`.
    - **Check 9 P4 (Edit box keeps the text):** the Edit box's Save changes and Send reply both go
      through `editorAction` (useActionState, `intent` = save | send); refusals answer inside the
      card (role=alert) and the editor stays open. Gaps show as words ([time], [job address]) with
      "Replace each [ ] before sending."; Send reply is replaced by "Fill in [time] first" while one
      is left; the text goes back with tokens (`toEditorText` / `fromEditorText` /
      `editorGapsLeft` in `src/ai/gaps.ts`), so the server's gap gate is unchanged.
    - **Check 43 P7 (stale "tomorrow"):** pure `staleTiming(body, createdAt, now, timeZone)` in
      `src/server/draft-timing.ts`: day words (today, tonight, tomorrow, this morning / afternoon /
      evening, this week / weekend, next week, later today; hoy, mañana, esta tarde; hoje, amanhã)
      when the draft's local day (owner's zone) is before today's; minute/hour words (in a few
      minutes, in an hour, shortly, right away) also when it's over 2 hours old. `sendDraft` and
      `queueSend` return `timing_check` {words, writtenOn, meant} before any Gmail call unless
      `confirmedTiming`; the queued send (`deliverQueuedSend`) passes it (the tap was checked
      seconds before); autopilot stands down with the note and can never confirm; batch counts it
      refused. The card shows "Written Friday. It says “tomorrow”, which meant Saturday. Check the
      timing." and Send reply becomes "Send reply anyway" (posts `confirmedTiming=1`), Edit stays.
      The JSON route takes `confirmedTiming: true` (else 409 `timing_check`); offline okays are
      refused with "its time words … may be out of date". **Wording differs from the spec** ("which
      now means Saturday" was wrong for a draft read days later): it says what "tomorrow" meant
      when written.
    - **Check 43 P9 (dispute caution; prompt `dispute-caution.v1`, new kind in the registry):** on a
      thread with `extracted.disputed` or the needs-owner reason LEGAL_REASON / DISPUTE_REASON,
      every draft (the owner's tap; jobs never draft these) and every quick change gets the fixed
      flag first ("This is about a dispute or something legal. What you write can be used later.
      Keep it short and factual; many owners call their lawyer or insurer first."), confidence
      capped at 40 (never Ready), and the fixed task line appended to the conversation's task.
      Stored prompt version `draft.v8+dispute-caution.v1` (was `draft.v7+…` on its branch) (or `revise.v2+…`). Eval cases
      `d-lawyer-reply`, `d-refund-dispute` (field `disputeCaution`); evals not run.
    - **Check 9 P10 (stopped / late sends):** `sentDraftSummary` now returns `stopped: {why}` when the
      newest send step for the draft is `send_stopped` (pending) or `send_stood_down` (expired),
      and `late` when its window ended over a minute ago and no job holds it. The Queue shows
      "Didn't send. It was changed in Gmail, so it's back below to check." (words shared with
      Activity via `sendStoppedWhy`), and lists late sends on top ("Waiting to send: reply to
      Priya", "Still sending. This is taking longer than usual.", Stop it = undo while unclaimed),
      refreshing every 10 s (`late-sends.tsx`, `lateSends()`).
    - **Check 38 P1 (change orders):** classification sets `extracted.change_order_approved` (only
      `true`, content-free) instead of `quote_accepted` when the email accepts and the thread's
      outcome was won before this email (`quote_outcome_at` < the email; any source; a legacy won
      with no time is not "before"). `createDraftForThread` never picks a deposit when the newest
      email is a change-order approval or the outcome was won before the newest customer email,
      and adds the fixed flag "Change order approved. Put it in writing with the price and any new
      finish date." Autopilot keeps refusing (accepts_quote). Eval cases `co-s3-lights`,
      `co-e02-vanity` (invented stand-ins: the review's E02 text wasn't in the prompt).
    - **Follow-ups on this branch:** the queue write also refuses a draft an autopilot run has
      claimed meanwhile (`already_sending`); the Send reply handler returns a kind and the actions
      redirect to fixed paths (the open-redirect fence, security-surface C4, stays unchanged).
  - **Draft checks (wave 1, group "Draft checks"):**
    - **Days and times as whole words (Check 20 P1 + 23 P3 + 23 P4, wave 1):** `src/ai/when-words.ts`
      (pure). `normalizeWhen` writes days, dates and times one way ("Fri" → friday, "8 a.m." → 8am,
      "Nov 27th" → november 27, "Mon–Fri" / "weekdays" → each day; "Sat", "Sun", "Wed" only when
      capitalised, since they are everyday words) and `whenTokens` turns them into keys; the check
      compares keys, never substrings ("fridge" no longer excuses "Fri"). New sources in
      `CheckContext`: `whenSourceText` (the conversation, seasonal notes **and their end dates**
      written "November 27", the owner's instruction / spoken words / a clean earlier draft — never
      the hours, lead time or policies), `hoursText` (its times always count; its days only with
      `allowHours`: the "Add my availability" tweak, or the customer asked when the owner is open,
      `asksWhenAvailable`), `leadTimeText` (only its "two weeks out" wording counts). Times now include
      "at 9", "around 8", "9:30", "9 o'clock", "10 a.m.", "in the morning"; loose timing adds "within
      the hour", "before the day is out", "by tonight", holidays as deadlines ("before Thanksgiving";
      any mention of the holiday in the conversation allows it), lead times ("three weeks out",
      "booked up through …"). A "today"/"tonight"/"tomorrow" whose only source is a customer email
      from an earlier local day gets "Says “tomorrow”, but they wrote that on Tuesday. Check the day."
      A never-promise item about same-day work is broken by "today", "tonight", "within the hour" or
      "before the day is out". Built in `whenContext()` in `src/server/drafts.ts` for new drafts and
      revisions. "This coming Friday" reads as Friday (the day token covers it).
    - **Money however it's said, round 2 (Check 23 P1 + 20 P11 + 36 P10, wave 1):** `moneyMentions`
      now reads k-ranges ("3-4k" → 3000 and 4000; not "model 3-4K" or "10k BTU"), spoken prices
      ("fourteen fifty", "twelve-fifty", "nineteen ninety-nine", "one fifty to come out" — only next
      to a price word; for one to twelve only the clearly-price words, since "it's nine thirty" is a
      time), "ninety-five bucks", "a buck fifty", "a hundred and a quarter/half", "seven hundred
      fifty" (750) and "two thousand five hundred" (2500), €/£, "dólares"/"reais"/"pesos" (with
      "1.500" thousands), "R$ 1.500,00", "mil quinientos", and the price words es / cuesta (unos) /
      custa / fica em. New `vagueMoney()` ("low four figures", "a few bucks", "couple hundred
      bucks"): autopilot's `mentionsMoney` counts it, and checkDraft flags it (hit `money`, cap 0.3)
      "Gives a rough price (“low four figures”). Check you want to name a number." unless the owner
      wrote it. Soft promise "for free" (also free of cost / won't cost you / we'll cover it); an
      owner whose text offers free estimates may say "estimates are for free".
    - **Claims, licenses and credentials (Check 23 P2 + 38 P6 + 36 P7, wave 1, migration
      `0039_licenses` on this branch — renumber at merge):** `business_profile.licenses` jsonb
      (`src/config/licenses.ts`: `hic_number`, `hic_expires_on`, `csl_number`, `lead_safe_license`,
      `insurance_carrier`; one line each, ≤40 characters). Settings → Your business → Edit business
      profile has a "Licenses and registrations (optional)" group (also in setup's optional
      section); a form without the fields leaves them alone, an emptied line clears it. Settings →
      Your business lists them and shows one line when the HIC runs out within 30 days (no email).
      **Never on the public site** (Davi: no license number published until confirmed). Drafting:
      `draft.v8`'s business block adds "Registration and licenses (quote exactly; never add
      others)" (so revise / follow-up / purpose prompts that share `workspaceBlock` see it too), and
      "Never invent" says never give another number or claim an unsaved credential; the numbers are
      owner text for the check. checkDraft: a number after HIC / CSL / CS- / MP- / JP- / MGF / LR- /
      license / lic. / registration / reg # (3+ digits) whose digits aren't in the owner's text →
      hit `license` ("Mentions a license or registration number you haven't saved. Check it.", cap
      0.3, in `REGENERATE_ON`), and the money finder never reads it as a price; "we're registered /
      licensed / lead-safe certified / insured" with the matching field empty and not in the
      owner's own words → hit `credential` ("Says you're registered and licensed. Add it in
      Settings or take it out.", cap 0.5, flag only). "Licensed" is also backed by a license
      number in the owner's text (a plumber's MP- in the signature). The old "licensed and
      insured" soft promise became these claims. Warranty / guarantee / promise words now compare
      with the owner's text only (a customer's "is that under warranty?" no longer excuses it). New
      soft promises: no permit needed (incl. "skip the inspection"), up to code, waived fee, price
      match, fit you in.
    - **Prompt versions after wave 1 "Draft checks":** `draft.v8` (Check 38 P6 so far; later steps
      add to it). `draft.v8` re-exports draft.v7's reply schema / openings / first-contact task and
      draft.v6's conversation block; its `workspaceBlock` is v6's plus the licenses line.
    - **Insurance-job promises (Check 40 P1, wave 1):** `INSURANCE_PROMISES` in draft-checks.ts —
      cover / waive / absorb / eat / take care of / pay the deductible, "insurance will cover",
      negotiating or dealing with the adjuster, handling the homeowner's claim, assignment of
      benefits, "sign … today", "free roof", "no cost to you" / "nothing out of pocket". Only when
      the owner never wrote it. Hit `insurance`, cap 0.2, in `REGENERATE_ON` (one fresh attempt),
      flag "Talks about the deductible or the insurance claim in a way you may not be allowed to
      promise. Check it." Any flag already keeps a draft out of autopilot and Send together (tested).
      `draft.v8` "Never invent" gains the deductible / claim / sign-today line.
    - **Lead-paint and safety claims (Check 41 P1, wave 1):** `SAFETY_CLAIMS` in draft-checks.ts —
      "no lead worries" (no need to worry about lead, lead-free, no lead), "safe for people or
      pets" (safe / harmless / non-toxic within a sentence of kids, baby, pets, dogs, family…,
      either order), "pet and kid safe" (pet-safe, kid-friendly…), and on an older home only
      (`olderHome()`: a year 1800–1977 near built / house / home / colonial, or "old house",
      "pre-1978", "victorian") power sanding, sandblasting, torching, burning off, heat guns. Only
      when the owner never wrote it. Hit `safety`, cap 0.3, in `REGENERATE_ON`; flag "Says “…”.
      Safety and lead claims are yours to make, not the assistant's. Check it before sending."
      `draft.v8` "Never invent" gains the safe / non-toxic / lead line. Eval cases: nursery paint,
      1924 colonial exterior, lawn treatment with dogs, mice bait with a toddler.
    - **Rule claims and rebate promises (Check 39 P4 + 37 P5, wave 1):** a draft sentence naming a
      program or rule word (rebate, incentive, tax credit / credit — not "credit card" — HEAT Loan,
      Mass Save, 0% loan, qualify, eligible, EPA, R-22, R-410A, R-454B, R-32, freon, refrigerant,
      banned, phased out, legal / illegal, no longer made / allowed, code requires) that the owner's
      own text (profile, price list, notes, instruction, their emails) never uses → hit
      `rule_claim`, "Says something about a rebate, tax credit or refrigerant rule. Check it's still
      true before sending.", cap 0.5, flag only (not in `REGENERATE_ON`, no extra model call). New
      soft promise "a rebate or utility will pay" (Eversource / National Grid / Unitil / Mass Save /
      the utility / rebates … covers / pays for / gives back / free / no cost; "you'll qualify for
      the rebate").
    - **“That's covered” and overages (Check 38 P7, wave 1):** new soft promises (owner-text rule,
      usual "make sure you stand behind that" wording): "that's covered" (that's / it's / this is
      covered, "covered under warranty / labor"; not "covered with plastic" or "you're covered for
      Tuesday"), "fix it for free", "add it to the (final) bill / invoice / price", "that's fine"
      right before an amount or "over", "no extra charge / cost / fee".
    - **Light payment-terms check (Check 23 P5, wave 1):** every ordinary reply now carries
      `termsSource` (payment terms + policies + price list, plus the owner's spoken words on a
      tweak) and `ownerWrote` (the owner's emails on the thread, a clean earlier draft). checkDraft
      flags a way to pay said the draft's way ("Venmo works", "by Zelle", "pay in cash"), deposit
      wording ("half down", "a deposit of", "30% up front") and credit terms ("net 30", "due in 15
      days", "pay later", "payment plan", "financing") that the owner's terms and emails don't say:
      "Mentions “net 30” — that isn't in your payment terms. Check it.", cap 0.5. **Adapted:** its
      hit is `payment_terms`, not `terms` as the prompt says, because `terms` is in `REGENERATE_ON`
      and the prompt says this one must flag without a rewrite. Off when a caller gives no
      `termsSource` (old callers unchanged). "Let me check" and "card" alone stay clean.
      (draft.v6's vocabulary line "T&M vs. fixed price, net 30" is Check 23 P11's, in the review's
      draft.v7 bundle — not done here.)
    - **Massachusetts deposit cap (Check 38 P2, wave 1; uses wave 0's `business_profile.state`, no
      migration):** "Which state do you work in?" (two-letter select, "Not set" allowed; in setup's
      optional section and Settings; **no** preselect from the browser's time zone — the owner
      picks it). `src/server/deposit-rules.ts` (pure): `depositShare()` reads the largest share paid
      before work ("50%", "40 percent down", "half down", "two-thirds up front", "a third at
      signing", "60/40", "in full up front"; a share only counts in a deposit clause, so "70% on
      completion" and "10% off" don't), `overMaDepositCap()` (> one-third, MA only; "33%" and
      "one-third" are fine). Wording and numbers in `src/config/ma-rules.ts`. An MA shop whose
      payment terms ask for more sees, under "How do you get paid?" and on Settings → Your
      business, "In Massachusetts a deposit can't be more than one-third of the contract, unless
      special-order materials cost more (c.142A §2). Check this line." (the save still goes
      through). checkDraft flags any MA draft (deposit notes included) that states a share over a
      third: hit `deposit_cap`, "Massachusetts caps a deposit at one-third, or the cost of
      special-order materials if higher. Check this before sending.", cap 0.5, never rewritten.
      `SelectField` gained `emptyLabel` (an empty choice the owner can pick).
    - **Phone numbers, links and names nobody gave (Check 23 P6, wave 1):** checkDraft flags (hit
      `contact`, cap 0.3, in `REGENERATE_ON` — one fresh attempt) a US phone number whose digits
      aren't in `sourceText` ("Has the number 978-555-0142, which isn't in your profile or this
      email. Check it."), any link or email address not in `sourceText` (a review request's own link
      keeps its own check), and a name the draft introduces — "my guy Pete", "our tech Luis", "the
      Hendersons", "for Marie last week" — found nowhere in the conversation, the profile or the
      conversation's From names (`knownNames`, from drafts.ts) ("Mentions “Pete”, who isn't in this
      email or your profile. Check it."). Narrow on purpose: greetings, towns, streets, days,
      holidays and brands ("for Eversource customers") don't trip it. At most two contact lines per
      draft. Any flag already keeps a draft from autopilot (tested).
    - **[name]-style blanks are gaps (Check 23 P7, wave 1):** `findGaps` now also returns the
      blanks the send gate already refused (`OTHER_PLACEHOLDER`): "[name]" → their name, "[time]"
      → time, "[date]" / "[day]" → date, "[price]" / "[amount]" / "$___" / "$X,XXX" → price,
      anything else → its own words; `fillGap` fills them the same way, in text order. So the card
      shows a chip, counts it in "Fill in N gaps to send", and never shows Send reply or Ready
      until it's filled. checkDraft adds "Has a blank (“[name]”) to fill in." (hit `blank`, cap
      0.6, no rewrite). The queue's gap notice is now "Fill in every blank before sending. Nothing
      was sent." Prompt **`voice.v3`**: sample replies use `{{custom:name}}`, `{{custom:address}}`,
      `{{date}}`, `{{time}}`, `{{price}}`; Settings → Your voice shows them as "[name]" etc.
      (`showGaps`), never braces. Profiles learned with v2 keep "[name]"; the card handles those.
      No voice eval set exists, so none was extended.
    - **Whole-word phrases (Check 23 P10, wave 1):** `phraseRegex()` in draft-checks.ts (escaped,
      inner spaces match any whitespace incl. a line break, no letter or digit either side, `iu`,
      curly quotes read as straight) for the never-say list, the voice's avoided phrases and FILLER.
      "hun" no longer flags "hunt", "sir" no longer flags "desire"; "Thanks hun!", "no problem!"
      and "a.s.a.p." still do.
    - **Filler variants (Check 23 P13, wave 1):** FILLER adds thanks (so much) for reaching out, I
      hope you're / you are doing well, hope all is well, don't / do not hesitate, I / we apologize
      for any inconvenience, at your earliest convenience, please be advised, rest assured, valued
      customer ("sorry for the delay" stays off). **Adapted:** on a first reply to a new lead
      (`firstContact` in the check context, from drafts.ts) "Thanks (so much) for reaching out" is
      not filler, because draft.v7's first-contact section (Davi, 2026-10-16) tells the drafter it
      may open that way.
    - **Price-list wording (Check 23 P14, wave 1):** `priceListRows()` reads each price-list line:
      its amounts, the qualifier on its first price ("from", "starting at", "starts at", "about"
      before it; "plus parts" / "+ parts", "per hour" after it) and its job words (longer than
      three letters, before the colon or the first price). checkDraft (given `priceList` = the
      owner's price list, from drafts.ts) flags a listed amount written without its qualifier
      ("Gives $1,450 without “from”, as your price list has it. Check it." — "from", "starting" and
      "starts" count as the same) or in a sentence with none of the line's job words, as whole words
      ("Uses your $1,450 price for something else. Check it."). **Adapted:** hit `price_list`, not
      `money`, because the prompt says these join `REGENERATE_ON` only if Davi says so (`money` is
      in it). Cap 0.5.
  - **Homepage words (wave 1, group "Homepage words"):**
    - **Homepage copy module (wave 1, Homepage words):** the homepage's steps, feature cards, FAQ,
      promise band and pricing paragraph live in `src/components/marketing/home-copy.ts` (pure);
      `src/app/page.tsx` renders them, and tests read the strings as visitors see them
      (`homepageFaq()` in `legal-docs.test.ts` now looks the answer up in `faqs`). Plan cards are
      `src/components/marketing/plan-cards.tsx`, keyed on plan ids.
    - **Rule numbers in one pure place:** `src/config/rules.ts` holds `EARN_THRESHOLD`,
      `GRACE_MINUTES` and `MAX_FOLLOWUPS` (re-exported from `src/server/autopilot.ts` and
      `src/server/drafts.ts`, so callers didn't change). The homepage builds every rule number from
      them (`numberWord()` in `src/lib/number-words.ts` spells 1–10).
    - **Trial length words:** `src/lib/trial-words.ts` (`dayWord`, `daysPhrase`, `dayAdjective`);
      nothing in `src/` types "three days" / "three-day" / "Day N of 3" / "3 more days" (guard test
      in `tests/unit/trial-words.test.ts`, skipping `src/ai/prompts/` and comment lines; setup
      steps "Step 1 of 3" aren't the trial and aren't caught). `TRIAL_NO_SEND_LINE` is built from
      `pricing.evaluationDays`. The trial banner is `TrialClock` (`src/components/app/trial-clock.tsx`)
      and says the clock's own length (`daysPhrase(clock.of)`), so a trial extended in /admin reads
      "Day 3 of 6 · … your six days". `trialLengthDays(w)` (lifecycle.ts) gives the same length to
      the Send reply note and the after-trial reason/banner ("Your six days are up."). Activity:
      "Your three days started" (config), "Your trial ended", "Your trial was extended by three
      days". Practice copies say "During your trial, Squared Away only sends to you." Admin buttons:
      `Give ${evaluationDays} more days` / `Add ${evaluationDays} days`. A unit test fails with "ask
      Davi to update the terms" if `evaluationDays` changes while `docs/terms.md` says "three-day
      trial".
    - **Plan lines by id:** `src/server/plan-features.ts` (pure): `FEATURED_PLAN`,
      `planFeatureLines(id)`, `autopilotPlanNames()`, `SIGN_INS_PER_PLAN`. Used by the homepage
      cards, `/billing` and autopilot's lock reason. No page compares a plan's display name.
    - **First payment on the homepage cards:** each card shows `firstChargeLine(id, true)` (the
      setup fee always included for a visitor), as `/billing` does. The standalone "Plus sales tax
      where it applies." note is gone from the homepage and `/billing` (each card's line says it);
      `SALES_TAX_NOTE` stays exported.
    - **Setup call wording:** `SETUP_CALL_COVERS` + `setupCallSentence("before" | "after")` in
      `billing-rules.ts`: "your prices, hours, service area and the things you never promise", then
      "tune your drafts until they sound like you". Used by the homepage setup box, `/billing`
      (before and after paying) and the setup_paid banner. "Scheduling" is gone.
    - **Homepage feature cards (nine):** Knows your trade · Won't take orders from strangers · Sorts
      every email (with the morning summary as its last sentence) · Writes like you · Chases quiet
      quotes (only quotes the customer emailed about and the owner emailed back; "Quotes sent from
      other software are left to that software"; "I called them" stops it) · Every quote in one list
      (stage names from `stageLabel`) · Who owes you · Your customers, in one place · Your data stays
      yours. No "Buzzes you" card (phone alerts aren't live until the VAPID keys are in) and no
      Autopilot card (its rules are in the first FAQ, the plan cards and the pricing paragraph,
      which now also says autopilot never answers a complaint or sends a reply that mentions money).
    - **Queue picture:** shows Send reply (across the card) with Edit and Discard under it, as the
      real card lays them out; no trial banner inside the phone; one caption under it: "Example.
      During your three-day trial it drafts like this, but won't send to a customer."
    - **Join button:** the header says "Join the waitlist" (was "Get on the list"), like every other
      join action.
  - **Safety guards (wave 1, group "Safety guards"):**
    - **Gas, propane, CO and smelly water (Check 22 P4 + Check 36 P1):** `mentionsGasSmell`
      (`src/ai/guards.ts`) first removes printed advice ("Smell gas? Leave the building…", "if you
      (ever) smell gas…", "gas odor calls…"), then matches gas / propane smells, a gas leak (not "gas
      leak detector / test"), a leaking or hissing gas line, Spanish and Portuguese, and a red tag only
      next to the word gas or propane (an electrical inspector's red tag is not a gas leak).
      Rotten-egg / sulfur smells are gas **unless** every one sits in the same sentence as a water word
      (water, shower, faucet, tap; "water heater" doesn't count) and nothing names gas, propane, a
      meter, stove, range, oven, furnace, boiler, pilot or dryer — then `mentionsWaterSmell`:
      needs you at normal priority, `WATER_SMELL_REASON`, `extracted.water_smell`, owner-rule key
      `water_smell`, no safety note, no emergency. The model's `smells_gas` only overrides the water
      reading when the email names gas or propane.
    - `mentionsCarbonMonoxide`: a CO word (carbon monoxide, CO alarm/detector, "co2 detector") with
      something happening within 60 characters (went off, going off, sounding, a reading, ppm,
      detected, headaches, dizzy…; beeping only without battery/chirp), or "detector going off" next
      to a furnace / boiler / heater (not a smoke detector). An install quote is not an alarm.
      `CO_REASON`, `extracted.co_alarm`, urgency emergency, owner-rule key `co_alarm`; treated like gas
      everywhere (needs you, high, emergency lane and night alerts through the urgency mark, autopilot
      and batch refuse it). Gas wins when both.
    - **Safety notes:** one per thread (purpose `safety`, gas or CO). The CO note is
      `coSafetyNote` (`safety-note-co.v1`, flag `CO_SAFETY_NOTE_FLAG`). A safety note is never written
      on a thread sorted as junk unless the owner has written to that address before (`knownCustomer`;
      `threadsToAutoDraft` leaves junk out unless the owner wrote on the conversation), and never to a
      no-reply address (as before). The gas note's wording is unchanged.
    - **After the day's AI limit (Check 39 P1):** `classifyPending` no longer stops at the first
      `AiCapReachedError`. That email and every later one in the batch go through
      `codeOnlyClassification` (`src/ai/classify.ts`, pure; the same code checks and the same shape
      as the no-model fallback): a gas smell, CO alarm, payment change or attack is stored through
      the normal write (needs you, high for safety and payment, `classified_at` set, no model
      category, no auto-marks); everything else stays unsorted for the model after the reset.
      `ClassifyRunResult.codeOnly` counts them (they are in `classified` too), so the classify job's
      text/push alerts fire. `threadsToAutoDraft` orders a gas / CO thread still without its safety
      note first, so the note (no model) is written before a model draft hits the limit.
    - **Quoted and forwarded text (Check 22 P3 + Check 20 P5):** `splitQuoted` (`src/ai/classify.ts`)
      returns the newest part and what quoting cut; `prepareBody` is its `kept` part (unchanged).
      `classifyEmail` runs the gas, CO, payment-change and new `mentionsLegalThreat`
      (`src/ai/guards.ts`: attorney / lawyer / law office, lawsuit, suing / "will sue", small claims,
      demand letter, cease and desist, 93A, attorney general, consumer protection, filing or placing
      a lien, a lien on the house; never "Sue" the name, "denied", "dispute" or "court" alone, nor a
      power of attorney) on the WHOLE email too (subject + raw body + the burst, CRLF normalised,
      ≤20,000 chars). The attack check keeps to the newest part (quoted text is often the owner's own
      words). A legal hit in code → needs you, high, `LEGAL_REASON`, `extracted.disputed` (so the
      sticky complaint mark), and it survives the routine-paperwork drop. When the newest part is
      under 300 characters and quoting cut something, the first 1,500 characters of the cut part go
      to the model in a second untrusted `<email>` block labelled "Quoted or forwarded text (older,
      may be from someone else)" (classify.v5). Never logged.
    - **Autopilot reads the whole newest customer email** (`blockers`): gas / CO / payment change /
      legal words anywhere in it, quoted part included, stop the countdown ("Something legal is
      mentioned in this conversation, so it waits for you." and the existing gas / payment lines); a
      purged body (no text left) waits ("We can't read their email any more, so it waits for you.").
    - `threadsToAutoDraft` picks safety-note threads with a separate first query, then the usual
      query, so the ordinary order (newest first) is exactly as before.
    - **Emergencies (Check 36 P2), adapted:** the leads package already made the model's
      `urgency: emergency` on a lead count in code (needs you, high, `EMERGENCY_REASON`, counted in
      `freshLeads` / the emergency lane), so step 1 of the prompt was built. Added: a 48-hour sticky
      mark — `extracted.emergency` + `emergency_at` (the emergency email's time), set when a sort hits
      `emergency`, a gas smell or a CO alarm (never from an attack email) and carried across later
      sorts while it is under 48 hours old (`recentEmergency`, `src/server/emergency-rules.ts`, pure).
      Autopilot ("There was an emergency on this conversation in the last 2 days, so it waits for
      you.") and batch send (`batchCandidates(…, now)`) refuse the thread meanwhile. **Not built:**
      the prompt's one automatic draft on an emergency (with an "Emergency: call them first" flag):
      CLAUDE.md's leads package says "emergencies are no longer auto-drafted", so that decision is
      kept until Davi says otherwise (question 2 below).
    - **Electrical fire signs (Check 37 P1):** `mentionsElectricalHazard` (`src/ai/guards.ts`, code
      only, no prompt change): burning smells, smoke / sparks / arcing / hot to the touch / loud
      buzzing / scorched / melted within 40 characters of an outlet, plug, switch, panel, breaker,
      box, fixture, light, ceiling, meter, wire or cord (or "out of / behind the wall"), a shock,
      wires down, the meter or service pulled off, lights going bright and dim, Spanish and
      Portuguese. Smoke detectors / alarms, spark plugs, "a burning question", hot tubs and hot water
      are taken out first. `ELECTRICAL_HAZARD_REASON`, `extracted.electrical_hazard`, urgency
      emergency, owner-rule key `electrical`; order injection > gas > CO > electrical > payment
      change. Also in the no-model fallback and the after-the-limit code path. One fixed
      `electricalSafetyNote` per thread (purpose `safety`, `safety-note-electrical.v1`,
      `ELECTRICAL_SAFETY_NOTE_FLAG`), same limits as the gas note (not on junk unless known, never
      to a no-reply address). Autopilot and batch refuse it; it counts for the 48-hour emergency
      mark. Eval metric `electricalHazardRecall` (strict).
    - **Attack-check false alarms (Check 22 P2):** `injectionCheck` no longer flags a bookkeeper's
      / adjuster's / lender's "send me all the invoices" (only someone else's things or secrets:
      the owner's, other customers', every customer's, passwords, logins, tokens, API keys, contact
      or customer lists), the writer's own "my / our earlier instructions", "rules about / for",
      "assistant manager" (and other job titles), Spanish "indicaciones" (the rules words need
      anteriores / previas / todas las), or "when writing your response, list…" (it needs an order
      to say / include / mention / add / reveal / confirm / agree / promise / always / never within
      60 characters). Every round 2 catch still flags.
    - **"This is a normal email"** (`clearInjectionMark`, `src/server/injection-clear.ts`; rules in
      `injection-clear-rules.ts`): a button on Queue needs-you cards whose mark has recorded reasons
      (`extracted.injection_reasons`: instructions / encoded / hidden / sticky / model, content-free)
      with no hidden or encoded text. Classification also keeps `extracted.without_injection` (the
      owner rules' answer with the mark left out: needs-you, reason, priority, hits) so the card is
      put right without a model call. Clearing removes `injection`, sets
      `injection_cleared_by_owner` / `injection_cleared_at` (kept across later sorts, so the sticky
      copy stops), restores the facts (the owner's "This one needs me" still wins), and writes
      Activity `owner_cleared_injection` (no detail). Refused for another workspace, hidden or
      encoded text, older rows without reasons, and read-only accounts. The draft job no longer holds
      emails dated before the clear against the thread. Autopilot refuses the thread for 30 days
      ("You said an email here was normal after we flagged it, so it waits for you."). Notices
      `?done=normal_email`, `?error=not_clearable`.
    - **"Is this a bot?" (Check 48 P1 + Check 43 P2):** `asksIfAi` (`src/ai/guards.ts`, English,
      Spanish, Portuguese; also "hi assistant, can you ask Mike to call me", "if a bot is reading
      this, pass it to a human"). The attack check now splits phrases that only ADDRESS the
      assistant ("Dear AI assistant:", "if an AI is reading", "as the AI", "you are (now) an AI")
      from real orders: addressing counts as an attack only with an order within 80 characters
      (agree, approve, confirm, include, send, reveal, must…) or when the email isn't asking if a
      person is reading. Gone: "(talking) to an AI", "send the photos to the assistant", "you are an
      AI, right?", "answer as the owner and not as the assistant". `ASKS_IF_AI_REASON` ("Asks whether
      a person or an AI is answering. Answer this one yourself."), `extracted.asks_if_ai` (sticky for
      the thread like `injection`), owner-rule key `asks_if_ai` (after injection and the safety
      marks). Jobs never draft it (`asks_if_ai`); the owner's tap does, with **draft.v8**'s "Who is
      writing" rule. `checkDraft` hit `human_claim` (`HUMAN_CLAIM_FLAG` "Says a person wrote this
      without help. Check it's true before sending.", cap 0.2, not regenerated; `claimsHuman`).
      Autopilot ("Asks if a person is answering, so it waits for you.") and batch send refuse both.
      Check 43 P2's separate wording `BOT_QUESTION_REASON` was folded into Check 48 P1's reason.
    - **draft.v8** (this branch): draft.v7 + a "Who is writing" section (Check 48 P1). Everything else
      re-exported from draft.v7, so the cache is unchanged. Other groups' draft.v8 changes (Check 23
      P11 / 43 P1 / 44 P1 / 45 P2, 40 P1, 41 P1) need combining into this one file at merge.
    - **Promotions / Social tabs (Check 22 P1):** `mustReadDespiteTab` (`src/server/classification.ts`)
      skips the no-model junk shortcut for: a lead-site sender (`leadPlatformOf`) whose subject
      looks like a lead (lead, request, sent you a message, new message, quote, estimate, hired,
      booked); facebookmail.com with "lead" in the subject; permit / inspection / certificate of
      occupancy in the subject or snippet; and anything the code checks catch (gas, CO, electrical,
      payment change, attack). A lead site's own marketing keeps the shortcut. The municipal, phone
      and sticky-mark exceptions are unchanged; the shortcut's result shape is unchanged.
    - **Payment change (Check 22 P5):** `looksLikePaymentChange(text, { supplier })` splits "pay
      somewhere new" (pay / wire / send TO a new account, "update your records … new bank", "don't
      pay the old account", gift cards of any brand up to three words) from "details changed", which
      counts only with "our" / "the" and an ask within 60 characters (update, use, send, remit, pay,
      wire, attached, below, going forward) — or always for a supplier (`supplier_vendor` sort, or a
      thread whose stored `bill_direction` is `owed_by_business`). A customer's own card, bank or
      payment info ("my", "I") never counts. classify.v5's `payment_change_request` says the same.
      The reason text is unchanged.
    - **Real legal words (Check 22 P11 + 36 P6 + 45 P4):** `REAL_LEGAL` drops "denied", "denial" and
      a bare "court" (kept: "take / see you in court", "court date / case / order"); "dispute" counts
      only as disputing a charge / bill / invoice / payment, "disputing the / your…", "filed a
      dispute" or a chargeback. Added other states' words (DTPA, FDUTPA, CUTPA, CSLB / Contractors
      State License Board, Registrar of Contractors / "ROC complaint", DBPR, TDLR, licensing board
      complaint, recovery fund, deceptive / unfair trade practices) and Spanish (abogado(s),
      demandar, poner una demanda, queja formal; not "corte" or a bare "demanda"). A lawyer word in
      the same sentence as closing / title / real estate / purchase and sale is not a threat. Both
      `mentionsRealLegal` and the code legal check `mentionsLegalThreat` use the sentence rule and
      the state words. Note: removing "dispute" alone / "court" / "denied" can drop a legal mark that
      was set before, as Check 22 P11 and 36 P6 ask; Check 45 P4's "only add" applies to its own
      words. Evals not run (`pnpm eval --no-drafts` needs `ANTHROPIC_API_KEY`), so needs-owner recall
      wasn't measured live.
    - **The money limit (Check 38 P3 + 22 P6 + 39 P2):** in `applyOwnerRules` the amount rule
      never applies to junk (`noise`), ignores `incentiveAmounts` (a "$" figure with rebate,
      incentive, tax credit, credit of, loan, financing, 0%, zero percent, per ton, grant, Mass
      Save, HEAT Loan or utility program in the same clause within 40 characters; whole dollars) and
      amounts the owner already wrote on the conversation (`ownerAmounts`: `moneyMentions` of the
      owner's own non-draft, non-side emails, quoted text cut; never logged). "New customer asking
      about a big job." now reads before "Mentions more than $X." (`owner_rule_hits` already holds the
      content-free codes, so no `owner_codes`). `extracted.dollar_amounts` is stored as the model
      gave it. `prepareBody` also cuts at an Outlook header block (From: then Sent:/Date: and
      Subject: within four lines, only below something the sender wrote) and at Spanish "El …
      escribió:" / Portuguese "Em … escreveu:". Setup asks a remodeler (main or extra trade) for the
      amount up front with the hint "Most of your job emails mention big numbers…" and suggestion
      buttons (`AMOUNT_SUGGESTIONS` in `src/config/trades.ts`; $10,000 / $25,000 are the review's
      examples, question 4); other trades keep it folded. The stored default ($2,500) is unchanged.
      The eval stand-in now lists every $ figure, and the unit test checks each case's needs-you
      against the code; `v-statement` now expects needs-you (question 5).
  - **When things break (wave 1, group "When things break"):**
    - **Check 18 P1 (alert emails can't stop jobs):** `sendAccessLostAlerts` and `sendCostAlerts`
      catch each row (log `access_alert_failed` / `cost_alert_failed` with ids + `err.name`; nothing
      marked, so the next run retries) and return `failed`. `workspace-lifecycle` and
      `purge-expired-bodies` call `reportAlertFailures` (`AlertFailuresError`, counts only) after
      their last step, like `reportSummaryFailures`.
    - **Check 16 P1 (one stuck inbox shows on /admin):** `mailboxTrouble()` in `src/server/admin.ts`
      (watched = mailbox on + account's jobs allowed; stale = backfilled and last check older than
      `STALE_SYNC_MS`, the owner's own 30 minutes; stuck first read = no backfill
      `FIRST_READ_STUCK_MS` (2h) after `createdAt`). `systemHealth` adds `staleMailboxes` /
      `stuckFirstReads`; the System box inverts with "An inbox looks stuck" (unless jobs look
      stopped). `AdminRow.mailboxes` adds `stale`, `oldestStaleSyncAt`, `stuckFirstRead`,
      `errorCode` (fixed code). Card phrases in `src/server/admin-mailbox-rules.ts` (pure); "healthy"
      only when nothing applies; an inverted "Stuck" line tops the card.
    - **Check 17 P1 (pause/resume):** migration `0039_paused_from` (additive):
      `workspaces.paused_from` (workspace_status, nullable). Pause stores `effectiveStatus`; Resume
      goes to `resumeTarget` (paused_from; a run-out evaluation → expired) and clears it. While
      paused, `applySubscription` and `applyCheckoutCompleted` keep status `paused` and write Stripe's
      answer into `paused_from` (log `subscription_changed` with `pausedFrom: {before, after}`).
      `resumeTarget` never returns setup_paid / active for `setup_paid_via = 'stripe'` with no
      subscription id (→ canceled), with or without paused_from; the house account is unchanged.
      (The checkout-while-paused case is an extension of the spec: a checkout started before the
      pause and paid after it used to un-pause the account.)
    - **Check 16 P2:** `ADMIN_MOVES.extend_evaluation` = evaluating / evaluation_expired only (not
      invited: the clock starts on the first Gmail connect). docs/google-verification.md's
      "Give 3 more days" line still holds (it's about trial accounts).
    - **Check 29 P1 (broken AI answers):** `src/ai/client.ts` calls `messages.create` with the same
      parameters `messages.parse` sent and parses the first text block itself
      (`parseStructuredText`: JSON.parse + Zod; any failure → `parsed: null` with the real usage).
      Every returned answer is recorded in `usage` with its cost. `isProviderFault` = APIError with no
      status / 408 / 429 / ≥500, or APIConnectionError (timeouts included); only those are refunded,
      our own errors are not. maxTokens: drafts and rewrites 4096, voice 8192 (Sonnet thinks inside
      max_tokens). `data-paths.test.ts` now checks for `messages.create` (was `messages.parse`).
    - **Check 48 P3 (missing / overloaded model):** `ModelUnavailableError(role, model)` in
      `src/ai/client.ts` for a 404 or a 400 saying the model isn't available: refunded, logged
      `ai_model_unavailable {role, model, promptVersion}`, `recordModelDown` (`src/server/model-alerts.ts`)
      writes `app_settings` `model_down:<model>:<UTC day>` (first time seen) and emails Davi once per
      model per day through the new `notifyAdminOnce` (`src/server/admin-notify.ts`, marker
      `admin_notice:<key>` written only after Resend took it; purged after 3 days in the daily purge
      job). Jobs wrap model steps in `stopIfModelMissing` → `NonRetriableError` (classify, draft,
      follow-ups, voice, voice ideas, found money); `captureEditSignals` keeps the counts without the
      tone so the purge job still runs. Stand-ins in `modelFallbacks` (`src/config/models.ts`):
      classify → `claude-haiku-5-5`, draft / voice → `claude-sonnet-5-5`, all
      `fallbackApproved: false`; used only for a missing model or a 529 after the SDK retries, once
      per call; migration `0040_fallback_calls` (`usage.fallback_calls`, additive) and
      `fallbackUsed: true` on the `ai_call` line. /admin's System box: "Sorting stopped since <time>:
      model not available (<model>)." and the heading "Sorting is stopped" (integrator: each line and the heading name the part that stopped, see the merge block above).
    - **Check 48 P4 (model time limits):** `aiTimeouts = { interactiveMs: 45000, jobMs: 90000 }`,
      `aiMaxRetries = 1` in `src/config/models.ts`. The client is built with them (e2e mode still
      overrides with `maxRetries: 0`); `callStructured({ mode })` ("job" by default) passes the time
      left as the SDK's per-request `timeout` and also races its own deadline (one deadline for the
      whole call, stand-in included), so a call that never answers ends as
      `APIConnectionTimeoutError`: refunded, logged `ai_call_failed { error: "timeout" }`. Draft a
      reply, tweak chips / Change it / Other ways to reply and the Inbox offers pass
      `aiMode: "interactive"`; a slow, down or missing model (`isTemporaryAiFailure`) redirects to
      `?error=ai_busy` "Writing is slow right now, so nothing changed. Try again in a moment."
    - **Check 1 P4 (deep health check):** `/api/health/deep` (`HEALTH_TOKEN` as `x-health-token` or
      `?token=`, else 404): `select 1`, the newest active mailbox check, and
      `app_settings` `jobs:workspace-lifecycle:last-run` (written by a new last step `record-run` of
      the 15-minute job; before the first one, the newest mail check stands in). Answers
      `{db, jobs: ok|stale, minutesSinceJobs, minutesSinceMailCheck}` (no ids); 503 when stale
      (> 30 min) or the database is down, and then "Background jobs look stopped" to Davi at most once
      per UTC hour (`notifyAdminOnce`, key `jobs_stopped:<hour>`). `/api/cron/jobs-check` does the
      same for Vercel Cron (`Authorization: Bearer <CRON_SECRET>`, else 404) but is **not
      scheduled**: no `vercel.json` was added (see Questions). `reserveAiCall` also emails "An
      account used 80% of today's AI limit" once per account per UTC day (no account named; link
      /admin; 5 s timeout, never fails the call). security-surface's route table has the new
      "shared-secret" guard. SETUP.md §6g + two env rows; `.env.example` has both names.
    - **Check 50 P6 ("Ready for paying owners" on /admin):** pure `launchChecks(env, facts)` in
      `src/server/launch-ready.ts` (7 automatic rows from env names and safe facts: APP_URL not
      *.vercel.app, EMAIL_FROM not resend.dev, SUPPORT_EMAIL set, Stripe key live / test / no key,
      a webhook secret in env or stored by Connect Stripe, INNGEST_SIGNING_KEY set, VERCEL_ENV
      production; 10 hand rows ticked by Davi). Ticks = `app_settings` `launch_tick:<key>` (ISO date)
      via `tickLaunchAction` (requireAdmin; logs `launch_ticked {key}` only); `loadLaunchFacts` never
      selects the webhook secret. Box (`src/app/(app)/admin/launch-ready.tsx`) sits under the System
      box: "N of M done", Done / Not yet (inverted) / Check by hand (outlined), a 44px Done button on
      un-ticked hand rows. No gate reads the ticks; there is no Undo (a mistaken tick is fixed by
      deleting the app_settings row).
- **Wave 2 merge A (2026-10-18, branch `integrate-w2a`):** the Voice, Inbox, Sync and Gmail
  connect, and Queue screen groups merged with `--no-ff`, in that order, on top of cc34707 (main
  plus the referral offer). Migrations regenerated one at a time with drizzle-kit on the previous
  snapshot (SQL byte-identical to each branch's; the voice branch's hand-edited 0040 snapshots
  were dropped and `learned_from_mailbox_id` regenerated without a foreign key from the schema):
  `0046_voice_attempts`, `0047_voice_learned_from`, `0048_voice_examples_stale`,
  `0049_voice_retries`, `0050_needs_owner_since` (was `brown_dreadnoughts`; adds
  `threads.needs_owner_since` and `quote_dismissed_at`), `0051_gmail_units`, `0052_resync_cursor`,
  `0053_attachment_counts`, `0054_job_runs`, `0055_backfill_cursor`, `0056_mailbox_email_index`,
  `0057_onboarding_done`. Prompt lines the groups couldn't write wait in
  `docs/notes/prompt-versions-inbox.md` for the Prompt versions group (voice-examples.v1, the
  classify reason wording, `acknowledgment_only`, the follow-up "look it over" line, the
  `Attached:` line and photo rule). Reconciled with wave 1:
  - The 15-minute `workspace-lifecycle` job is four `runChecks` steps (clock / backstops /
    housekeeping / alerts, at most 4 `step.run`, one try/catch per check with a Sentry capture);
    wave 1's `enforce-plan-autopilot` is in clock, `restartVoiceLearns` (not
    `workspacesNeedingVoice`) in backstops, `runReferralRewards` and the voice clean-up in
    housekeeping, Check 1 P4's `record-run` last in alerts. A failed check throws
    `LifecycleChecksFailedError` at the end, then Check 18 P1's access-alert report
    (`reportAlertFailures`). A failed check isn't retried within the run (its step is memoized); the next
    15-minute run tries again.
  - `deliverQueuedSend`: the Trash/Spam check (`threadGoneInGmail` → `left_inbox`) runs before
    `sendDraft(…, { queued, confirmedTiming })`; wave 1's answered-elsewhere stand-down stays.
    `reconcileDrafts`: an auto-reply never expires a draft, beside wave 1's Gmail-reply rule.
    `runAutopilotSend`: wave 1's stale-timing note and sync's "left your inbox" both stand it
    down; `blockers` reads the customer's subject, body and `auto_reply`. `threadsToAutoDraft`
    keeps wave 1's safety-first shape plus the auto-reply / acknowledgement filters.
  - Classification: wave 1's `codeFallback` (model failure and the AI-cap code path) now also
    stores `extracted.unreadable`, so Inbox says "Couldn't sort"; the Inbox group's plain reasons
    (`COMPLAINT_REASON` etc.) with wave 1's `legalThreat` check; `OLD_LEGAL_REASON` stays a
    dispute reason. Wave 1's new safety reasons already had no dashes.
  - Voice: `learnVoice` keeps `voice.v3` and 8192 max tokens around the scrub, accepted ideas and
    stale samples; the reader is `serverMailboxClient` with `{ sentOnly, newerThanDays: 365 }`.
  - Activity's `sendStoppedWhy` gains `archived_in_gmail` / `left_inbox`; Settings → Your Gmail
    has the free-month limit and note with the first-read progress and `?add=1`; Inbox cards
    carry Draft ready, attachments and the bounced line together; `CalledThem` takes both `back`
    (Inbox, fixed `/inbox` redirects) and `compact`, and the Queue's next-card redirect; queue
    draft cards keep the referral merge's `autopilotOpen` check and the attachment line.
  - `resyncPage` also clears answered "Needs you" when a re-read finishes (Check 10 P1).
  - Integrator decisions: `runVoiceIdeaCleanup` (`src/server/voice-idea-cleanup.ts`, housekeeping,
    `app_settings` `cleanup:voice-idea-edited-v1`, tested): a voice marked `edited` with an idea
    accepted after its newest `voice_learned` and no `voice_profile_edited` since goes back to
    `learned`, so the weekly refresh runs again. /admin's "jobs look stopped" waits 25 minutes
    (`JOBS_STALE_AFTER_MS`; push on, the poll leaves a quiet inbox for up to 15 minutes). Privacy
    policy: the voice scrub "recognizes" (and covers the stored description, not only examples),
    speech goes to "Google, Apple or Microsoft", "What you tell us" names license and registration
    numbers, "What we store" names attachment counts. Legal date and `TERMS_VERSION` unchanged.
- **Wave 2 merge B (2026-10-18, branch `integrate-w2b`):** the Quotes and Money, Settings and
  time zone, Follow-ups, Customers and senders, and Autopilot rules groups merged with `--no-ff`,
  in that order, on top of 5b4579d (merge A). Migrations regenerated one at a time with
  drizzle-kit on the previous snapshot (SQL byte-identical to each branch's): `0058_quote_amount_note`,
  `0059_quote_amount_from`, `0060_time_zone_source`, `0061_work_hours`, `0062_reply_languages`,
  `0063_nudge_after`, `0064_owner_invoice_at`, `0065_big_quote_days`, `0066_autopilot_skip`.
  Prompt lines the groups couldn't write wait in `docs/notes/prompt-versions-inbox.md`
  (classify.v6 `declines_quote` / `wait_until` / the "unknown" first-time sender; followup.v5
  invoice reminders; the reply-language line). Reconciled with merge A and each other:
  - **One quote rule:** `quoteThreadSql` / `isQuoteThread` = Quotes' rule (category, sticky
    `quote_requested_at`, any outcome; noise / injection left out unless the owner marked it)
    **and** the Inbox group's "Not a quote" (`quoteNotDismissedSql`; an owner outcome after the
    dismissal brings it back). `quoteRequestSql` is an alias. Customers' conversation stages use
    the same rule and Check 11 P6's priced test (`pricedThreadIds` in quotes.ts).
  - **Who wrote last, everywhere:** `threadsToFollowUp` and `guessNoAnswers` keep the Sync
    group's ball-in-their-court (an acknowledgement or auto-reply since the owner wrote doesn't
    count) and count the quiet from `quietSinceSql` — against the normal and big-quote waits and
    with the asked-for wait on top (`greatest(quiet start, nudge_after)`). A fresh invoice email
    (no customer email) is the other way in. `guessNoAnswers` also keeps the priced pre-filter,
    this-quote-only nudges, service calls and the big-quote clock. The drafter keeps the bounce
    and acknowledgement rules beside wait / not-due; the service-call check reads the owner's
    newest email, never a later acknowledgement.
  - **listQueue** keeps the Queue group's needsYou / drafts / now shape and lanes; each item also
    carries the reply languages, `alsoQuote`, `customerKey` and `autopilotSkip`. Queue cards keep
    the h3 name heading with the `CustomerName` link inside it; `CustomerName` now wraps a long
    name (Check 32 P11) instead of cutting it. The draft card shows the language line above
    "Check before sending" and the autopilot wait line in the header; the queue note line shows
    "Also about your quote", the private note and attachments.
  - **Autopilot codes:** besides the Autopilot group's own, `crew` (Customers), `auto_reply`
    (Sync, Check 20 P4) and the run code `left_inbox` (Sync, Check 25 P2: "This conversation left
    your inbox in Gmail.") — each with one sentence, one phrase and one Settings line.
    `autopilotOnKinds` takes `AutopilotWorkspace` (the referral free-plan fields).
    `threadMessageLabels` uses the gmail client's unit names (`threads.get`).
  - **Money card:** the follow-ups group's chasing line replaces "Nudges used" at 16px
    (`data-testid="chase-line"`, read by the Check 8 P9 e2e), beside Quotes' "See it" / "Draft a
    reminder" and `CustomerName`. **Quotes card:** a decided card says when ("Won Oct 14"); an
    open service call reads "Service call"; "I sent the price another way" and "Not quotes" stay.
  - **Settings:** Your Gmail uses the settings group's pure `syncLine` (one email, no check time)
    with the Sync group's "This can take a while."; Your business's every-fact list gains "Your
    crew" (a count); `SettingsScreen` keeps `errorText` beside `fillCounts`.
  - **Integrator decisions:** a price typed on Quotes' "I sent the price another way" is the
    owner's (`quote_amount_from = 'owner'`, `quote_amount_at` = the tap): never replaced by a
    price read from mail, never in price memory, and — like any typed amount — not in "Priced"
    unless the quote is won. That tap without a price reads "Quoted", not "Replied, no price yet"
    (`answered_by_phone` with `via: "other"`). Inbox cards say "Your crew" in place of the kind. The
    sent screen's nudge promise (`sentDraftSummary`) also stops for "Not a quote", a bounce and
    the crew (mark or a crew To), like the scan; Money's "Draft a reminder" uses the scan's
    needs-you rule (`needsOwnerBlocksNudge`, so a big invoice can be reminded) and any invoice
    thread.
- **Wave 2 merge C (2026-10-18, branch `integrate-w2c`):** the Mail format, Town / utility /
  job-kind lists, Numbers and Activity, and Billing and admin groups merged with `--no-ff`, in
  that order, on top of 05bb296 (merge B). Migrations regenerated one at a time with drizzle-kit
  on the previous snapshot (SQL byte-identical to each branch's): `0067_from_name`,
  `0068_send_as`, `0069_stripe_money_events`. Prompt lines the Lists group couldn't write wait in
  `docs/notes/prompt-versions-inbox.md` (classify.v6: water and sewer offices / backflow notices,
  Check 36 P5; electric-company paperwork, Check 37 P3). Reconciled with merges A and B:
  - **One "plan set to end" column.** The Billing group's `workspaces.plan_ends_at` (Check 17
    P3) was the referral offer's `stripe_cancel_at` under another name (same rule: `cancel_at`,
    else the first item's period end with `cancel_at_period_end`; null once ended). Its
    migration was dropped; `billingStatusLine` ("Your plan ends on Nov 16…"), the banner's
    last-7-days line and `plan_cancel_scheduled` read `stripeCancelAt`, and `cancelAtOf`
    (billing-rules.ts) is the only rule (`planEndsAtFrom` removed).
  - **The webhook** keeps the referral offer's shape — a fresh read with `discounts` expanded,
    then `applyLiveSubscription` (status, plan, `stripe_cancel_at` and the plan effects in one
    transaction: `applyPlanChange` → `autopilotPlanEffects` by `effectivePlan`, and
    `fitMailboxesToPlan`), then `reconcileReferralSafely` and `creditReferralSafely` — with the
    Billing group's checks in front (orphans, stale and second subscriptions, the second one
    adopted when the stored plan ends) and its notices after (`notifyBillingChange` for past
    due / recovered / canceled, never paused or house). A subscription Stripe no longer has
    (`resource_missing`) counts as **canceled** (Check 17 P4; the referral offer used the
    event's copy). `applyCheckoutCompleted` keeps the Billing group's paid / unpaid /
    no_payment_required split and second-checkout rule, and the referral offer's single
    transaction (status, plan, setup paid, plan effects, inbox fit).
  - **`applyPlanChange(workspaceId, from, to, by, now, executor)`** (workspace-lifecycle.ts) is
    now `autopilotPlanEffects` plus one `plan_changed { by, from, to }` row when the plan moved;
    called after the plan is written (inside the transaction on the Stripe paths). A running
    free month on a plan with autopilot keeps it. `setWorkspacePlan` keeps the Billing group's
    Stripe guard (`PlanSetByStripeError`, conditional update) and calls it.
  - **/admin** keeps the Growth admin page link, wave 1's launch checklist and stuck-inbox box,
    batch A's background-work line, the referral offer's plan label (`planLabel`, free month
    included), free-month lines and portal lines, beside the Billing group's Needs you box, find
    and paging, card notices, support page and payment lines. The 25-minute "jobs look stopped"
    threshold (merge A) stands. The AI costs page shows "· free month" with /admin's status
    labels.
  - **/billing and the banner** keep the free-month section, Keep / Go back and the downgrade
    line beside `PaymentWaiting`, the checkout notices and "Update card"; Choose a plan hides
    for `setUpWithoutStripePlan`. The setup_paid / active banner shows the free-month card and
    then the plan-ending line.
  - **Activity:** `DESCRIBED_ACTIONS` (the SQL filter) also lists every action batches A and B,
    the referral offer and Billing log (referral lines are answered first by
    `referralActivityLine`, so the Numbers group's own `mailbox_plan_swap` /
    `mailboxes_fit_plan` cases were dropped). New plain lines: `needs_owner_cleared`,
    `quote_dismissed` / `quote_restored`, `mail_gap`, `mailbox_in_use_refused`,
    `reply_languages_saved`, `work_hours_saved`. `second_subscription` is hidden on purpose
    (an /admin signal). The guard test also reads billing.ts's `log(id, "action")` helper.
  - **The electric company everywhere a town office is kept out (integrator):** review and
    thank-you offers treat `extracted.utility` as untrusted, Found money's one-tap drafting
    and the "never answered" leads leave it out, beside `municipal`.
  - **Autopilot:** the electric company is a guardrail code, `utility` ("The electric company
    always waits for you.", one Settings line "Emails from the electric company."); town emails
    already had `municipal`, and since they now always need the owner they also hit
    `needs_owner`.
  - **Queue cards** (the shared `draftCard`) show the From line (name · alias), the subject,
    the permit card and town caution under Needs you, and the "No signature" line on the page's
    first draft card (the same card as the swipe tip), beside batch A/B's lines.
  - **Gmail units:** `listSendAs` is charged as `settings.sendAs.list` (1 unit) in `GMAIL_UNITS`.
  - **Tests:** `FakeStripe` (tests/support) gained `subscriptions.list` and
    `checkout.sessions.expire`; tests that call `applySubscription` put the subscription in the
    fake first (`fake.subscriptions.set`). admin-no-content also runs `accountsNeedingYou`,
    `countWorkspaces`, `moneyEventsFor`, `openDisputeCount` and the Stripe markers, and scans
    admin-rules.ts and stripe-money-rules.ts.
- **Wave 2 merge D (2026-10-18, branch `integrate-w2d`):** the Data and speed, Phone look and
  accessibility, Security and limits, and Phone alerts and the app groups merged with `--no-ff`,
  in that order, on top of 27e4704 (merge C). Migrations regenerated one at a time with
  drizzle-kit on the previous snapshot (SQL byte-identical to each branch's; speed's index file
  keeps its hand-written `IF NOT EXISTS` and size-check comment): `0070_data_speed_indexes`,
  `0071_thread_prompt_version`, `0072_session_version`, `0073_push_failures`,
  `0074_sms_deliveries`, `0075_sms_code_tries`. No prompt lines came out of these four groups.
  Reconciled at the merge: the Queue and Inbox pages keep batches A–C's cards (lead cards,
  attachments, autopilot waits, the From line, the card-anchored notices) inside speed's two-wait
  loading; `getWorkspaceForSession` keeps speed's one-query-per-request React `cache()` (keyed on
  the user id and session version, since `session.user` is a fresh object per `auth()` call);
  the static homepage's Growth form reads a referral link's `?ref=` in the browser through the
  shared `ReferralField` (src/components/marketing/referral-field.tsx), like the waitlist form;
  the Quotes group's tests run `quoteUpkeepForMailbox` before reading Quotes (screens read, jobs
  write); batch C's `reportStripeWaitingAction` and alerts' `/api/push/subscription` have
  `LIMIT_SITES` rows, and that route checks the session version like every other API route;
  the read-only price list on /billing names "Your plan" like the checkout list; the admin move
  `sign_out_everywhere` lands its notice on the card (Check 16 P6) and is a described Activity
  line.
  - **Indexes (Check 30 P1/P4, Check 29 P6):** every foreign key leads an index
    (`tests/unit/fk-indexes.test.ts`; allow-list with reasons). Index migrations are plain
    `CREATE INDEX IF NOT EXISTS` (drizzle runs migrations in one transaction, so no CONCURRENTLY);
    check table sizes first and pre-build big ones by hand with CONCURRENTLY. The reply-address
    expression lives once in `replyAddressExpr` (schema.ts) so the planner matches its index
    (`tests/unit/query-plans.test.ts`). `/admin`'s "last sorted" / "last morning email" are
    per-mailbox / per-workspace scalar subqueries (`lastSortedQuery` / `lastDigestQuery`).
    **`messages_mailbox_reply_address_idx` (Check 30 P4, `customerDetail`'s lookup) shipped in
    `0070` and is dropped again in `0076_drop_reply_address_index` (2026-10-19, CI
    `old-code-new-schema` on PR #14).** With it, main's `notesForThreads` (no ORDER BY; it takes
    the first row at `max(sent_at)`) gets same-second inbound emails from the planner in
    reply-address order instead of insertion order, and main's control test reads the wrong note.
    A first attempt (238dd83) regenerated 0070–0075 without the index — wrong: 0070–0075 had
    already run on the shared database from the previous push's preview build, so the new hashes
    and `when` values made the migrator try them again and the build failed at `0071`'s
    `ADD COLUMN`. The repair restored 0070–0075 byte-for-byte and added `0076`, a plain
    `DROP INDEX IF EXISTS` and the one reviewed non-additive migration in
    `migrations-additive.test.ts` (dropping an index never breaks old code). `schema.ts` has no
    index; the planner matches `replyAddressExpr` only when it returns (an additive
    `CREATE INDEX IF NOT EXISTS` in a new migration, plus the plan assertion in
    `query-plans.test.ts`) once main carries this branch's `order by id` tie-break (this PR). At
    today's sizes the lookup is one mailbox's inbound rows; no measured loss.
  - **Extracted facts (Check 30 P6):** `threads.classified_prompt_version` records the classify
    version that wrote `extracted`; read `extracted` with `readExtracted(extracted, version?)`
    (src/server/extracted.ts), not casts. A new classify version that adds keys adds its schema
    there.
  - **Screens read, jobs write (Check 29 P7):** opening a screen never writes; quote amounts and
    no-answer guesses are refreshed by the draft job after every sync (`quoteUpkeepForMailbox`,
    step `quote-upkeep`, never fails the job) and the daily jobs. A "no answer" guess appears
    within one sync (about 5 minutes) or the daily scan, not the moment Quotes opens. Shared
    per-request reads (`getWorkspaceForUser`, `listMailboxes`, `getBusinessProfile`,
    `termsAccepted`) use React `cache()`; Queue and Inbox load in two `Promise.all` waits.
  - **AI limit (Check 29 P4/P5):** a shop's daily limit is `AI_DAILY_CALL_CAP` (500) per running
    inbox, at least one, up to `AI_DAILY_CALL_CAP_MAX` (3000) (`dailyAiCallCap`, SQL twin
    `dailyAiCallCapSql`). Sorting may use 80% of it (`SORT_SHARE`, `reserveAiCall(..., "sort")`;
    every `callStructured` caller passes a `purpose`); drafts and voice keep the rest. At
    sorting's share the top note says "Most of today's assistant limit is used. New email waits
    until 8pm to be sorted…". Prices and plan inbox limits unchanged.
  - **Homepage from the CDN (Check 29 P3):** `src/app/page.tsx` reads no session and no search
    params, so "/" is prerendered. The signed-in redirect is in `src/proxy.ts` ("/" in the
    matcher; a GET/HEAD with an Auth.js session cookie → `/start`, rule in
    `src/lib/home-redirect.ts`); a stale cookie lands on /signin. Referral codes: the forms read
    `?ref=` in the browser, only when the page passed `referrals` (= `referralsVisible()` at
    build time). `isReferralCode` lives in `src/lib/referral-code.ts`.
  - **Phone tab bar and focus (Check 32 P2, Check 8 P2/P5):** the bottom `<nav>` has
    `data-tabbar` (keep it there); under 640px `html:has([data-tabbar])` gets
    `scroll-padding-bottom` for the bar and `scroll-padding-top: 16px`. The viewport is
    `viewport-fit=cover`; the (app) wrapper `#sa-app` (class `sa-app`) pads all four safe areas;
    every other page pads on `<body>`. Manual iPhone checks: docs/SETUP.md §11.
  - **Back to the app (Check 8 P3):** `RefreshOnReturn` calls `router.refresh()` after ≥60s
    hidden, never while a text box has focus or anything has `data-editing="true"` (the draft
    card while Edit or Change it is open; rules in `src/lib/refresh-rules.ts`). Tapping the tab
    you're on scrolls to the top and refreshes. Queue, Inbox, Quotes and Money show "Updated
    9:41 AM" (`UpdatedAt`).
  - **Sunlight is client-only (Check 8 P4):** `SunlightButton` flips `data-contrast` on `#sa-app`
    and writes the `sa_contrast` cookie from the browser (not httpOnly; a display setting).
    `toggleSunlightAction` is gone; cookie names live in `src/lib/device-cookies.ts`.
  - **Notices are read out (Check 32 P5):** one always-present polite live region (`Announcer`,
    root layout) in a closed shadow root; `Notice` is a client component (`role="status"`,
    `aria-live="off"`) that writes its words there; strong notices stay `role="alert"`. Tests
    keep finding notices with `getByText` / `getByRole("status")`; `tests/e2e/announcer.ts` reads
    what was announced. `AutoSaveForm` + `FocusAfterSave` put focus back on the saved switch.
  - **Titles (Check 32 P6):** root `title: { default: "Squared Away", template: "%s · Squared
Away" }`; pages set a short title and never write "· Squared Away" by hand
    (`tests/unit/page-titles.test.ts`); Queue is "Queue (N)".
  - **axe in e2e (Check 32 P8):** `@axe-core/playwright` 4.13.0 (exact); `tests/e2e/a11y.spec.ts`
    fails on serious/critical. Fields: `<label htmlFor>` holds the label only; hint and error are
    the control's description (Check 32 P10). `SkipLink` first on every screen, every `<main>` is
    `id="main"` (Check 32 P12). `tests/e2e/tap-targets.spec.ts` sweeps 375 and 320px (skip
    `.sr-only:not(:focus)`).
  - **Two tones, enforced (Check 7 P2/P3/P5/P9/P11, Check 1 P5):** no `opacity-*` greys on text
    (`two-tone.test.ts`; use `text-muted-foreground`), `variant="ghost"` only in the confirm
    components (`buttons.test.ts` allow-list), every field uses `border-input`
    (`input-contrast.test.ts`), featured panels are `border-2 border-charcoal bg-card`, never
    inverted (`inversion-uses.test.ts`). Sunlight uses a variable-weight Inter Tight instance;
    /app-icon (every size, the badge too) draws in Inter Tight Black; `scripts/favicon.ts`
    rebuilds favicon.ico.
  - **Sign out everywhere (Check 26 P3, `0072_session_version`):** `users.session_version`; the
    jwt callback stores it as `sv` on a fresh sign-in; `getWorkspaceForSession(session.user)` /
    `signInIsCurrent` return nothing unless `sv` equals the account's version. `requireOwner`,
    `requireSignedIn`, `requireAdmin`, `/signin`'s bounce, every API route and the Gmail callback
    use it. **A cookie with no `sv` is refused**, so every owner (Davi too) signs in again once
    after this deploys. Settings → Account → "Sign out of every phone and computer"
    (`signOutEverywhereAction`, log `signed_out_everywhere` {by}); /admin → "Sign them out
    everywhere" (`ADMIN_MOVES.sign_out_everywhere`, changes no status). Every unit test that
    mocks `@/auth` needs `sv: 0`; e2e `signInAs` reads the account's version.
  - **Delete my account needs a fresh sign-in and the typed word (Check 26 P4):** `sat` (sign-in
    time) in the JWT; `requireRecentSignIn(15)` → `/signin?next=…&reason=recent`; both delete
    actions need the form field `confirm` = DELETE (`account-deletion-rules.ts`). Google can't be
    made to ask for a password again (no `prompt=login`).
  - **No row values in query errors (Check 26 P5):** `src/db/safe-errors.ts` wraps Drizzle's
    `queryWithCache` once and rethrows `SafeQueryError` ("Failed query: <first SQL line>" + code;
    params, cause and stack dropped; `.code` kept). Inngest middleware `ScrubErrors` runs
    `scrubText` over job errors. The unit-test date guard fails with code `SA_DATE_BOUND_INTO_SQL`.
  - **Notices take own keys only (Check 26 P6):** `noticeText(map, key)`
    (`src/lib/notice-text.ts`) for every `?done=` / `?error=` lookup in src/app (a unit test fails
    on plain `map[params.x]`); `isCategory` uses `Object.hasOwn`.
  - **Replacing the encryption key (Check 26 P7):** `decryptSecret` tries `TOKEN_ENCRYPTION_KEY`,
    then `TOKEN_ENCRYPTION_KEY_PREVIOUS`; `pnpm reseal:secrets` re-seals every refresh token and
    `v1.` app setting (docs/SETUP.md §5a). Rotating the key no longer means every owner
    reconnects.
  - **Draft a reply 90/h, counted at the model (Check 40 P3):** `createDraftForThread` takes
    `beforeModelCall` (runs once, right before the model is asked; false → skipped
    `rate_limited`); taps that end in already-pending / no text use nothing. Refusal →
    `/queue?error=draft_limit&until=<ms>` ("You can ask again at 10:00am.",
    `draft-limit-rules.ts`).
  - **Every rate limit is proven wired (Check 31 P4):** `LIMIT_SITES` in
    `tests/unit/security-surface.test.ts` has one row per `hitLimit` call in src; a new call needs
    a row.
  - **Headers, robots, Pub/Sub (Check 26 P9/P10):** `poweredByHeader: false`,
    `Cross-Origin-Opener-Policy: same-origin`, robots.txt no longer names /admin. Gmail push
    checks Pub/Sub's signed ID token (`src/server/pubsub-auth.ts`; `GMAIL_PUSH_AUDIENCE`,
    `GMAIL_PUSH_SERVICE_ACCOUNT`; keys from `www.googleapis.com`, on data-paths' Google line);
    the old `?token=` is accepted only while neither is set (one `gmail_push_legacy_token`
    warning per cold start). docs/SETUP.md §6a describes only the signed setup.
  - **Dependencies, CI, smoke (Check 26 P11, Check 31 P6/P7/P8):** `shadcn` in devDependencies;
    `source-map-js@<1.2.2` overridden to `^1.2.2`; CI runs `scripts/audit-check.ts` (high /
    critical advisories in production dependencies fail unless listed in
    `.github/audit-allow.txt`); `.github/dependabot.yml` security updates only. CI runs on push
    to `main`, on `pull_request` and `workflow_dispatch` only (a `claude/**` push without a PR
    runs nothing); Playwright also reports JSON in CI and `scripts/flaky-report.mjs` lists tests
    that passed only on a retry. `.github/workflows/smoke.yml` runs the smoke specs against
    production after each successful Production deploy (`PRODUCTION_URL` repository variable;
    `/api/health`'s commit must match). vitest `hookTimeout` 60s; `tests/support/setup.ts` holds
    snake_case console lines until a test fails.
  - **Alerts after drafting (Check 19 P1):** classify-mailbox raises only emergencies right away
    (`emergencyAlertsForMailbox`); the ordinary new-lead text / buzz is draft-mailbox's last step
    `lead-alerts` (`alertsForMailbox`, after `quote-upkeep` and the drafts), so the queue it opens
    already shows the reply. `/api/push/summary` names fresh quote requests with no queue card
    (`newQuotesWithoutCard`) and opens `/quotes`; `freshLeads` also returns `threadId` and
    `lastMessageAt`.
  - **Push failures (Check 19 P2/P5, `0073_push_failures`):** try/catch per owner and per
    phone; no phone took it → slot and cursor handed back (`releasePushSlot`), no Activity row.
    `recordPushResult`: gone → row deleted; sent → `fail_count` reset; failed → counted, and a
    phone failing for 7 days (`PUSH_FAILING_FOR_MS`) is deleted. `PushToggle` re-saves this
    phone's subscription on every visit; `POST /api/push/subscription` (session, terms, same
    origin, `poll` limit) swaps a renewed address (`sw.js` `pushsubscriptionchange`).
  - **Service worker (Check 19 P3, Check 46 P3/P5):** the summary lookup gives up after 4
    seconds so every push shows a notification (Safari drops silent ones). Badge =
    `/app-icon/badge-96` ("sa." alone, light, transparent). `refresh-offline` re-saves
    `/offline.html` at most once a day per phone: editing public/offline.html is enough.
  - **Code texts and delivery reports (Check 19 P4/P6/P9, `0074_sms_deliveries`,
    `0075_sms_code_tries`):** `normalizeUsPhone` refuses toll-free and N11 area codes; a refused
    code text clears the code and number (`SmsError("send_failed")`); the fifth wrong guess
    throws the code away (`sms_code_tries`, one conditional update). `sendSms` sends
    `StatusCallback = APP_URL/api/twilio/status` and returns `{ status, sid }` (the `SmsSender`
    type); `sms_deliveries` keeps each report (no body, no number; purged after 30 days);
    `POST /api/twilio/status` checks `X-Twilio-Signature` (403 otherwise, always 403 without the
    token). 21610 (STOP) / 30006 (not a mobile) switch texts off with
    `business_profile.sms_stopped_reason` and one Activity line; Activity's `sms_alert_sent`
    reads "Texted you…" only once delivered (`deliveryId`, never Twilio's id).
  - **Caps and quiet hours (Check 19 P7/P8):** the ten-a-day caps count from the owner's local
    midnight; the tenth text ends "That's today's last text; the rest wait in the app."
    `secondsUntilQuiet` (until 9pm local, ≤4h, ≥60s) is the push TTL (`PushSender` takes
    `{ ttlSec }`) and the text's `ValidityPeriod` (Messaging Service only); emergency alerts keep
    the 4-hour TTL.
  - **Get the app (Check 46 P1/P2/P4):** `installSteps(ua, maxTouchPoints)`
    (`src/lib/install-steps.ts`) per browser; the manifest has `screenshots` (3 × 1080x1920 from
    `scripts/app-shots.mjs`, invented e2e data only), `lang`, `dir`; pwa.spec asks Chrome's
    `Page.getInstallabilityErrors`. The installed app stays locked upright on Android
    (`orientation: "portrait"`) until Davi says otherwise.
- **Wave 3 merge A (2026-10-19, branch `integrate-w3a`):** `w2-prompts` (wave 2 Prompt
  versions), `w3-legal` (Legal text, one release), `w3-google` (Google review and the domain) and
  `w3-emails` (App emails), then `w3-growth-site` (Growth site and form) merged with `--no-ff`,
  in that order, on top of faef9a5 (`w3-growth-records` waits for the preview database split). Migrations regenerated one at a time
  with drizzle-kit on the 0076 snapshot, SQL byte-identical to the branch's:
  `0077_voice_writers` (when 1792390564735), `0078_snow_trade` (1792390572405; `ALTER TYPE trade
ADD VALUE 'snow' BEFORE 'other'`, alone in its migration), `0079_trade_other` (1792390574464),
  `0080_waitlist_mail_host` (1792397235019). Proved on scratch databases: fresh from 0000 (81
  rows), and faef9a5's folder first, then this one (only 0077–0080 applied; the guard passed; a
  second run applies nothing). No textual conflicts between the first three; the
  connect screen keeps legal's "Share your email" item and google's `GOOGLE_APP_STATE` line, and
  /admin keeps legal's support-email line, google's Video script link and prompts' "Something
  else: pest control" waitlist words.
  - **Kept as on faef9a5 (no okay from Davi to change when CI fails):** `.github/workflows/evals.yml`
    stays hand-run only (the branch added a pull_request trigger), and `tests/unit/evals.test.ts`'s
    "saved eval record matches the prompts in use" runs only once a baseline has been recorded
    (the branch made it fail from 2026-10-26 with none). Both are proposals in LAUNCH step 13.
  - **Time zone race (integrator fix):** Settings → Morning email could render before the first
    page's background zone save (`ZoneCapture`) landed, still showing Eastern; Save then posted
    Eastern and `setOwnerTimeZone` stored it as the owner's pick (over the browser's zone, with a
    `time_zone_changed` row the owner never made). This was the e2e "morning summary time and time
    zone are saved" failure seen by three builders under load. The form now posts the zone it
    showed (`timeZoneShown`); `pickedTimeZone()` (`time-zone-rules.ts`) saves only a zone the
    owner changed. activity.spec holds the detection request to prove it, and the original test
    waits for the browser zone to be saved before opening the screen.
  - **classify.v6** (Check 12 P2 + 12 P3 + 22 P9 + 38 P5 + 45 P7, plus every inbox line for it):
    `extracted.invoice` is a running balance — `amount` stays the key (the full amount billed;
    the review's `invoice_total` was not used so stored rows keep one shape), plus
    `amount_paid_now`, `kind` (invoice / payment / credit) and `other_invoices` (merged into
    `earlier_open` on store, so the stored list is always `[]`). `money-rules.ts`:
    `InvoiceFacts.paid`, `balanceDollars()` (never below 0), `isMoneyToward()`;
    `carryInvoiceFacts` adds payments, never opens an invoice for a payment or credit, and
    payments that cover it read as `paid` (our paid guess, `settledByPayments`). Money and
    `owedCents` use the balance; `matchReceipt` accepts the balance or the whole amount. Status
    `said_sent` ("check is in the mail") counts as owed, never sets `invoice_paid_at`, and holds
    nudges for `SAID_SENT_WAIT_DAYS` = 7 (`saidSentBlocksNudge`, SQL twin `saidSentHold`);
    `promised_on` shows "They said they'd pay Friday." The paid list says how we knew
    (`paidViaLine`). New owner rules: `fake_bill` (priority high, never on junk), `not_the_payer`
    (lead categories only), `contract_rights` (`mentionsContractRights` in guards.ts: cancelling,
    three-day window, deposit back, Guaranty Fund, arbitration, state complaint…; jobs never draft
    it, autopilot refuses it, never sets `complained_at`). Signals `acknowledgment_only`,
    `declines_quote`, `also_asks`, `new_job_requested`, `extracted.wait_until` (stored only as
    `followupSignalsOf`'s checked date). The sender's name, address and subject are fenced in
    `<header>`. `EmailInput.firstTimeSender: boolean | "unknown"`; an "Attached: 3 photos, 1 PDF
    (the assistant can't see them)" line per email (`attachedLine`). The paperwork line names the
    811 programs and the energy programs; `routine_paperwork` is wider (rebate letters, warranty
    claims, dispatches).
  - **draft.v9** (Check 23 P11 + 43 P1 + 44 P1 + 45 P2 + 39 P6, plus inbox lines): length and tone
    rules, one rule for unknown facts, "a gap replaces the words for the fact", answer every
    question in order, never say whether a permit is needed / what meets code / a warranty /
    waived fees / matched prices; the business block gains "- Owner's first name: …"
    (`ownerFirstName`), the reply-language line (`replyLanguageLine`, Check 43 P8) and, for a
    shop with a state file, "Words used in your state" (`src/ai/prompts/states/`, Massachusetts
    only: HIC, CSL, Mass Save / HEAT Loan names, never amounts; `stateWordsFor`). "Who is
    writing" (wave 1) stays; the review's fixed honesty line was **not** added (two rules for one
    question). `HUMAN_CLAIMS` gained "no AI" / "no assistant" / Spanish and Portuguese claims;
    "a real person" counts only as a claim about who is writing. Trade files: plumbing,
    electrical and HVAC lost the permit questions and gained the review's words and questions;
    no trade file asks whether a permit is needed (test). `buildCheckContext` (exported from
    drafts.ts with `ownerFactsOf`, `DraftContext`) is the one builder of `checkDraft`'s context
    for drafts and evals.
  - **followup.v5** (Check 12 P7 + 21 P7): `followupTask({ nudgeNumber, daysQuiet, kind,
acknowledgedOn })`; invoice reminders ask when they expect to pay, never an easy out
    (`EASY_OUT_FLAG`, flag only, cap 0.5), late fee or discount. Output `skip` (declined /
    asked_to_wait / already_answered / paid / other): no draft, Activity `followup_skipped`
    `{ code }`, `extracted.nudge_skip` / `nudge_skip_at`; the scan and the drafter leave the
    thread alone until someone writes (`nudgeSkipStands`).
  - **voice.v4 + voice-examples.v1** (Check 24 P5 + 24 P9 + 24 P8): sent mail is fenced
    (`<email n>` + `untrusted`), `injectionCheck` drops flagged bodies and flagged answers;
    `voice_profile.writers` (first names + most / some / few, scrubbed, ≤5) and Settings'
    `writersNotice`; a sign-off naming someone else isn't learned. `rewriteVoiceExamples` (no
    sent mail read; one guarded UPDATE, an edit made meanwhile wins), event
    `voice/examples.requested`, function `voice-examples`.
  - **Other prompts-branch code:** jobs skip `routine_paperwork` (reason `paperwork`; the owner's
    tap still drafts). `LEAD_SOURCES` gains Modernize, eLocal and roofle / roofr ("Instant quote
    on your website"), `site: null`; a reply address on those platforms (not a per-customer
    relay) is never drafted, not even on a tap (`lead_platform`). Trade `snow` ("Snow plowing";
    `trades/snow.ts`, `JOB_KINDS.snow`). "Another trade" asks which (`tradeOtherField`, ≤60, one
    plain line; stored only when the trade is "other"), shown on /admin waitlist rows and in
    draft.v9's "Trade:" line; not carried from waitlist to workspace. `REAL_LEGAL` ignores
    insurance disputes ("disputing the depreciation"); a lost-neutral line counts as an
    electrical hazard. Evals run the real path (`classifyPending` on stored threads), plus
    follow-up, voice and voice-example sets; `tests/support/fake-model.ts` parses fixtures
    through the real schema (`LooseClassification`). **Evals not run** (no key); one
    `it.todo` in `draft-checks-cases.test.ts` (a spoken figure like "fourteen fifty" isn't read).
  - **Legal text, one release (Check 50 P5):** `docs/terms.md`, `docs/privacy-policy.md` and
    `TERMS_VERSION` change only on a `claude/legal-<date>` or `integrate-*` branch, as one
    release. `tests/unit/legal-freeze.test.ts` diffs other branches against their merge-base with
    `claude/squared-away-mvp-ddxl7s` (skips when git can't name the branch or base — so it skips in
    CI's shallow checkout today). Wording waits in `docs/notes/legal-<branch>.md`; steps in
    `docs/LEGAL-RELEASE.md`. `LEGAL_DOCS_SHA256` (`src/config/legal.ts`) is the hash of both
    documents; `legal-docs-hash.test.ts` fails on any change, the integrator's included, until it
    is recomputed. `docs/legal-changes.md` (one section per version) feeds "What changed" on
    /welcome/terms; `TERMS_VERSION` may be `YYYY-MM-DD.N` for a second release on one day.
  - **Legal-branch code:** with no `SUPPORT_EMAIL` the legal pages' contact block offers a text
    link (`sms:`), and /admin's System box says so (inverted in production). Text alerts: the
    screen carries the carrier words (count, quiet hours, "Msg & data rates may apply", HELP /
    STOP, agreement line with 44px Terms / Privacy links); `sendSms` reads Twilio's error `code`
    only, 21610 → `opted_out` → `sms_stopped_reason`; `sendLeadAlerts` isolates each owner
    (`alertOne`; `sms_alert_failed` logs status and error name only). No `sms_opted_out_at`
    column. The connect screen's "Share your email" item names our US servers and Anthropic. The
    Markdown renderer joins wrapped lines before the inline pass; /privacy and /terms open with
    `<Headline>` ("the fine print,") and skip the file's `# Title`.
  - **Google review and the domain:** `GOOGLE_APP_STATE` (Production only; testing / unverified
    / verified, default testing; `src/config/google-app.ts`) is the one switch for what Google's
    consent screen shows: the connect screen's warning line and the access-lost email's reason
    read it. Never add a second env for the same fact. `legacyHostRedirects()`
    (`src/config/host-redirects.ts`) forwards every `vercel.app` page (never `/api/*` or
    `/_next/*`) only when `VERCEL_ENV` is production and `APP_URL` is an https non-vercel.app
    address. `pnpm google:ready <url>` and `pnpm check:headers <url>` (scripts/, read public
    pages only). `.github/workflows/casa-prep.yml` + `docs/casa-prep.md` (not run yet).
    `/admin/video` renders the demo video script from `docs/google-verification.md`
    (`src/server/video-script.ts`, 17 steps pinned) as 44px tick boxes in localStorage only; no
    loading.tsx (must 404); in the a11y, tap-target and noindex admin lists. The sitemap dates
    each page: `CONTENT_DATES` in `site.ts` for `/` and `/growth` (bump when the words change),
    the date part of `TERMS_VERSION` for /privacy and /terms (`legalDate()`). `/signin`,
    `/not-invited`, `/goodbye` are `index: false, follow: true` and out of robots' disallow list.
    Organization markup: logo, state-level address, `email` only from `SUPPORT_EMAIL`.
    public-site.spec's search basics keep one self-expiring exception, `waitingOn["/growth"]`
    (its description is 179 characters), until the Growth site group shortens it.
  - **App emails (`w3-emails`).** Conflicts: `src/config/google-app.ts` was written by both this
    group and the Google group; one copy keeps both groups' names (`googleAppStateFrom` is
    `parseGoogleAppState`) and the App emails wording for the access-lost reason, which Settings →
    Your Gmail (`mailboxHealth`) shows too. Its activity.spec change (waiting for the zone save,
    "a race in the test, not the app") gave way to the integrator's product fix above.
    - **Check 18 P2 (Email box on /admin):** `sendEmail` throws `ResendError` (name, numeric
      `status`); every sender logs `...emailErrorFields(err)` (name and status only). Refusals
      tallied per UTC day in `app_settings` `email-refused:<YYYY-MM-DD>` (purged after 14 days).
      /admin "Email" box (`email-health-rules.ts`, pure): "Not set up" / "Test sender…" (inverted)
      / "Sending from <address>", the week's refusals, and "Send me a test email" (admin only, 5
      an hour, to `ADMIN_EMAIL`, key `admin-test-<minute>`).
    - **Check 18 P5 (Reply-To):** owner-facing emails without one get `SUPPORT_EMAIL`, else
      `ADMIN_EMAIL`; notices to `ADMIN_EMAIL` itself pass `replyTo: null`.
    - **Check 42 P6:** Morning email and Your Gmail name the sign-in address the app emails go to,
      and warn when it isn't a connected inbox (`appEmailsGoTo`, `app-emails-to-rules.ts`; never
      logged).
    - **Check 18 P6 + Check 20 P12:** the morning email's sent line adds "(N by autopilot)"; the
      closing line names autopilot when any kind is on it (`footerLine`); an account in its three
      days gets a line linking `/billing`.
    - **Check 18 P7 + Check 7 P10:** one email shell (`emailShell` / `emailHtml` / `brandEmail`,
      `src/lib/email-layout.ts`; light only, hidden content-free preheader, 44px footer links).
      Brand hex colours live once in `src/config/brand.ts` (`BRAND`, equal to `--sa-k-*`);
      `brand-colors.test.ts` refuses any other hex in `src/**.ts(x)` (`public/offline.html` and
      `src/app/icon.svg` keep copies). New emails use `brandEmail` / `emailHtml`.
    - **Check 1 P7:** the access-lost email and Your Gmail give Google's 7-day limit as the reason
      while `GOOGLE_APP_STATE` is testing (the default).
    - **Check 18 P4:** "Email the sign-in link again" on /admin invites (once a day per address,
      30 taps an hour); `catchUpWaitlistConfirmations` sends missed "You're on the list" emails, 8
      per tap, shown only once the sender isn't `@resend.dev` (10 taps an hour).
    - **Check 47 P3:** `waitlist.mail_host` (google / microsoft / other / unknown) from the
      domain's MX records (`lookupMailHost`, `node:dns/promises`, 2 s, any error → unknown;
      `mail-host-rules.ts`, pure). /admin shows the host line and "On Outlook: N"; inviting a
      microsoft / other row needs "Invite anyway" (`inviteFromWaitlist` returns `needs_confirm`
      without it); `unknown` never blocks.
    - **Check 18 P8:** the at-risk line counts only leads with a queue card; the greeting and the
      quiet subject follow the local hour (`greetingFor`, `nothingWaitingSubject`).
    - **Check 18 P9:** morning and monthly emails carry `List-Unsubscribe` / one-click POST to the
      built `/api/emails/stop` with `k=digest` (its own signed purpose, so trial and digest links
      can't cross); POST turns off only `digest_enabled` and logs `digest_turned_off`
      {via: "unsubscribe"}; GET changes nothing and lands on a page that asks.
    - Four new rate-limit keys (`emailTest`, `inviteAgain`, `waitlistCatchup`, `emailStop`) with
      their rows in `security-surface.test.ts`.
  - **Growth site and form (`w3-growth-site`, base faef9a5, no migration).** Merged last, then
    **two of its commits reverted on this branch: 46d4e03 reverts 39a02ca** (Check 3 P1 + 3 P5:
    "what you get" lines on every service card, the new Reviews blurb, the ground rule's "offer
    anything in return for a review") **and 4f8bc6a reverts 163061b** (Check 3 P6 + 34 P4: the
    FAQs "Who pays for the ads?" and "How is this different from a marketing agency?"). Both are
    Davi's draft sales words and wait for his okay; re-apply with `git revert 46d4e03` /
    `git revert 4f8bc6a`, which brings their tests back too. Conflicts kept both sides: the
    restructured public-form actions (one `input` object) carry `tradeOther`;
    `joinWaitlist(input, source, { trapFilled, resolveMx })`; growth-boundary lists both new
    files. public-site.spec's `waitingOn["/growth"]` entry is gone (the description is 155
    characters).
    - **Check 3 P3 not built:** the Facebook and Instagram ad cards stay separate (Davi's call;
      the proposal keeps `instagram_ads` as a legacy id, no data migration).
    - **Check 2 P4 + 3 P2:** both ad blurbs say "in and around the towns you work in" (Meta's
      Housing special ad category); FAQ "Can my Facebook ads show only in my town?".
    - **Check 2 P1 + 3 P7:** banned in every Growth source file and the rendered copy: "book a
      free call", "booking", "find a time", "first page", "page one", "#1", "number one", "more
      leads", "google screened", "license verified", whole-word "rank".
    - **Check 2 P2:** `sendGrowthConfirmation` (through `brandEmail`; key
      `growth-confirm-<addressKey>-<New York date>`; Reply-To `SUPPORT_EMAIL` when set; fixed
      words and the business phone only), sent beside Davi's notice (`Promise.allSettled`).
      Live with the Resend domain.
    - **Check 2 P3:** the trap field is `sa_hp` (`trap-rules.ts`; `website` still counts). Trap +
      invalid form = polite success, nothing stored; trap + valid form = stored with
      `Flag: hidden field filled` (`TRAP_FLAG`), nobody emailed, /admin says "Might be a bot".
    - **Check 2 P6:** `siteConfig.operatorPhoto` (null) and `GROWTH_PROOF = []`
      (`src/config/growth-proof.ts`, `liveProof`: written okay date and a check within 12
      months); the proof section renders only for live items.
    - **Check 2 P7 + 6 P6:** ground rule 1 gives examples ("like sorting, drafts and
      follow-ups"); the homepage hand-off and bridge name the four services; the Big words read
      "Your inbox" → "Your marketing" (sizes 11.5vw / min(11.5vw, 14vh) in theme.css).
    - **Check 7 P7 + 6 P11:** names keep their capitals in headlines ("ask Davi to call you.",
      "your Gmail.", "reconnect Gmail.", a customer's name as written); `headlines.test.ts` scans
      every serif / heavy field.
    - **Check 2 P8 + 3 P4 + 5 P2 + 45 P5:** optional Growth form answers as lines in the
      `[Growth call]` block only (no columns): "Not sure yet — tell me what to do first" (a
      checkbox, never a card), how they heard and who sent them, state, and the browser's time
      zone; /admin shows "Works in AZ", "Their time now", "Heard", "Sent by". Not built: trade or
      services optional, town and the waitlist's state / town (C44 P3, needs a migration).
    - **Check 33 P2:** /growth title "Contractor marketing, done for you · Squared Away Growth",
      a 155-character description, the eyebrow, and `growthStructuredData` (one Service, no
      offers, ratings or areaServed) beside the Google group's Organization markup.
    - **Check 7 P4 + 7 P6 + 2 P9:** share card words spaced per span; `GrowthMark` on both
      Growth headers; services grid without a lone card; no Text button from `lg` up; /growth's
      header hides "The app" below `sm` (fits 320px).
    - **Check 29 P9:** `.sa-cv` (`content-visibility: auto` with measured content heights) on
      the off-screen homepage and /growth sections (`src/lib/deferred-section.ts`). The
      CPU-throttled crossing e2e is opt-in (`SA_PERF=1`) and its "< 120ms" claim is **not
      verified** (the shared machine read 250–350ms); run it on an idle machine before relying
      on it.
    - **Check 26 P8:** `LIMITS.formEmail` (5 a day per address, keyed by an HMAC `addressKey`)
      on both public forms. Not built: keeping the first request as well as the newest.
- **M12 merge (2026-10-24, branch `m12-integrate` on 305906e):** `m12-sms-summary` (#50 text
  summaries and waiting-quote texts) then `m12-outlook` (#49 Outlook behind `FEATURE_OUTLOOK`),
  both `--no-ff`. Only `drizzle/meta` conflicted (both builders took 0081); every other shared
  file (`settings/messages.ts`, `jobs/functions.ts` — the `texts` digest step and the
  `renew-outlook` step —, `schema.ts`, SETUP.md, FEATURE-PLAN.md) merged cleanly with both
  sides kept. Migrations regenerated one at a time with drizzle-kit on the 0081 snapshot (schema
  first without the two push columns and their index, then whole), SQL byte-identical to the
  branch's: `0081_sms_summary_texts` (when 1792873971346), `0082_outlook_provider`
  (1792884364392; the enum ADD VALUE, alone), `0083_outlook_push_subscription` (1792884366116).
  Proved on scratch databases: fresh from 0000 (84 rows), and 305906e's folder first (81 rows),
  then this one (84; `pg_dump -s` of both identical); `pnpm db:generate` afterwards finds
  nothing. Notes folded into queue-and-sending.md, gmail-and-sync.md and LAUNCH.md step 13 ("M12
  merge"); `legal-m12-*` kept for the legal release.
