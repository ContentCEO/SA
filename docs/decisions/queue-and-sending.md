# Queue and sending: drafts, the send gate in use, autopilot, follow-ups, alerts and the app's screens

Moved unchanged from `CLAUDE.md`'s "Decisions" section on 2026-10-19 (Check 49 P5), in their
original order. Rules that a test or gate depends on are also stated in `CLAUDE.md`.

- Nav: Inbox · Settings in the header; Sign out lives at the bottom of Settings. Signed-in home = /inbox.
  (Superseded: five tabs and Settings → Account, see "The app on a phone".)
- Onboarding: connect → `/welcome/profile` (only if the profile was never completed) →
  `/welcome/learning` (auto-refreshes every 5s until backfill + voice are done) → Inbox.
- Forms use `useActionState`; on error, focus + scroll to the first invalid field (phones).
- "Toasts" are currently `?done=` / `?error=` query params rendered as `<Notice>` (role=status/alert).
- **Drafts + Queue (M5):** `src/server/drafts.ts`, prompt `draft.v1` (Sonnet, effort medium, one
  retry). Auto-drafts only quote_request / customer_question / scheduling / invoice_payment /
  supplier_vendor threads that aren't needs_owner; the owner's "Draft a reply" (Inbox/Queue) may draft
  anything non-noise, including complaints. One pending draft per thread (partial unique index).
  Skips: owner replied last, no text, AI cap, model failure.
- Every draft is a **real Gmail draft** (`MailboxWriter`, `src/mailbox/mime.ts` builds the threaded
  MIME and strips CR/LF from headers). `checkDraft` (`src/ai/draft-checks.ts`) flags invented $,
  new days/times/dates, never-promise items and filler, and caps confidence — it never rewrites.
- **Send gate:** `src/server/lifecycle.ts` (`SENDING_ALLOWED = setup_paid, active`). `sendDraft`
  checks it before any Gmail call → `SendingBlockedError` → 403 from `/api/drafts/[id]/send`.
  Tested for every blocked status with zero Gmail calls.
- Before sending we re-read the Gmail draft: deleted → discarded; changed in Gmail → take the Gmail
  text and ask the owner to tap Send again (never send text they haven't seen in the app).
- `reconcileDrafts` (runs at the start of every draft job): new inbound → expire + delete the Gmail
  draft; missing draft + newer outbound → sent; missing → discarded; changed → take Gmail body.
- Swipe-left on a draft card only reveals Discard's confirm — no gesture ever sends.
- Draft text is purged with the same retention as bodies; pending drafts past retention expire.
- Pipeline: sync → classify (if new mail) → draft; sync with no new mail still reconciles drafts.
- Signed-in home is now `/queue`. Nav: Queue · Inbox · Settings.
- **Follow-ups (M7):** hourly cron `followup-scan` (:11); each owner's scan runs once a day at
  4am their time, due on the owner's calendar day (`nudgeDueDate`; Check 21 P3, wave 2 merge B;
  was daily 9:11am America/New_York). `threadsToFollowUp`
  (`src/server/followups.ts`): quote_request / invoice_payment, not needs_owner, owner wrote last
  ≥ `followup_days` ago (default 3; choices 2/3/4/5/7) and ≤ 21 days ago, customer has written at
  least once, < 2 nudges **sent**, no draft of any kind since the owner's last message (so a
  discarded nudge isn't rewritten until they write again), none pending.
- Nudges reuse `createDraftForThread` with `trigger: "followup"` (prompt `followup.v1`, kind
  `followup`, to = last inbound sender, threaded to the owner's last message). The cap, category and
  needs-owner rules are re-checked there, whatever selected the thread. Sent nudges bump
  `threads.followup_count`; the cap counts sent `followup` drafts. Reconcile also expires a pending
  nudge if the owner wrote to the customer some other way.
- Settings → Follow-ups: on/off + wait days (stored on `business_profile`). Every nudge is a draft;
  nothing sends without a tap. The sent screen says "A nudge for Dana will be ready Monday
  morning if there's no reply." (Check 21 P3; was "I'll nudge Dana on Thursday…") / "That was
  the last nudge. I won't chase this one again." for chased categories.
- **Digest + Activity (M8):** `/activity` (in the header nav) renders `activity_log` as plain
  sentences (`describeActivity`; unknown actions hidden) with the customer's first name from the
  owner's own synced mail, plus a month summary. Time saved = 3 minutes × drafted replies actually
  sent (`MINUTES_PER_SENT_REPLY`), labelled an estimate with the assumption shown.
- Digest (`src/server/digest.ts`): hourly cron `morning-digest`; due once per local day at/after
  `digest_hour` (5–9am) in the owner's `time_zone` (captured from the browser in Settings; invalid →
  Eastern). **Counts and categories only — no names, subjects or text** (email content only ever goes
  to the AI provider). Quiet days are skipped. Resend via plain fetch with
  `Idempotency-Key: digest-<workspace>-<local date>`; without `RESEND_API_KEY`/`EMAIL_FROM` nothing is
  sent and the day isn't marked done. Read-only accounts get none.
- **Resend 409s (2026-10-13, M8 review):** a retry whose body changed (summaries say how long
  things waited) gets 409 `invalid_idempotent_request`. `sendEmail` reports `already_sent` (the
  digest, monthly summary, cost alert and Gmail-access alert then mark it done) **only** when we
  hold our own `app_settings` `email-sent:<idempotency key>` row, written right after a 2xx
  (outside any marker transaction; purged daily after 2 days). Resend's docs don't say whether a
  key is kept when the first request was refused (e.g. 403 while `EMAIL_FROM` is
  onboarding@resend.dev); **not checked live** (no Resend key in the sandbox). To check: send to a
  forbidden address with a test key, retry the same key with a different body, and see 409 vs 403.
  Either way the code never marks an email sent without our 2xx. Any other 409 stays an error.
- **Autopilot (M9)** — `src/server/autopilot.ts`, approved by Davi 2026-10-03. Three layers, all
  in code with tests: (1) account: plan with `autopilot` (Crew/Company) **and** status `active`
  (setup call done) **and** setup really paid (`setupReallyPaid`, 2026-10-14: an unpaid active
  account's countdown could never send; `runAutopilotSend` also stands down when `!canSend`
  instead of letting `sendDraft` throw); (2) category: owner switched it on (`rules` table, mode draft|autopilot) and it
  has **earned** it — ≥10 replies in that category sent exactly as drafted from the app;
  (3) each email: eligible category (never complaint/noise), not needs_owner (incl. manual), reply
  not follow-up, confidence ≥ 85, no flags, no money in the draft, no amount on invoice emails, and
  the owner has **written to that address before**. Daily cap 20.
- Grace window: `considerAutopilot` sets `drafts.auto_send_at` = now + 10 min and the queue card shows
  "Autopilot sends this at 9:42 — Hold it". Job `autopilot-send` sleeps until then and
  `runAutopilotSend` re-checks every layer plus "no newer mail" before `sendDraft(..., by:
"autopilot")` (activity `reply_sent` actor squared_away, `autopilot: true`). Owner edit (app or
  Gmail), Hold it, switching it off, plan change or status change all clear the countdown.
  Backstop: the 15-min lifecycle job re-sends events for countdowns >5 min overdue.
- **Upgrades (2026-10-09, Davi: "everything you said, let's do it"):**
  - Gmail access lost → owner email (`src/server/alerts.ts`, 15-min lifecycle job), plus one
    reminder after 2 days; `mailboxes.access_lost_at` / `access_alerts_sent`, reset on reconnect.
  - Price list: business profile "Your price list" (the `pricing_notes` column), prompt `draft.v2`
    quotes listed prices exactly as written; `checkDraft` still flags any other amount; autopilot
    still never sends money.
  - Draft cards show the classification summary (what the customer wants) above the reason.
  - Quote tracker `/quotes` (`src/server/quotes.ts`, rules in `quote-rules.ts`): quote_request
    threads + anything marked; stage = owner's Won/Lost, else waiting_on_you / talking / quiet
    (owner wrote last ≥ follow-up days). Amount = largest $ in the owner's own reply (quoted text
    stripped), captured before the body purge (`captureQuoteAmounts`, daily + on view) or typed on
    Won. Totals over the last 30 days. `threads.quote_outcome/_at/quote_amount_cents`.
  - Customers `/customers` (`src/server/customers.ts`): grouped by lower(sender) of inbound mail,
    noise excluded; links use an **opaque key** (their newest message id) so email addresses never
    appear in URLs or logs; search filters client-side for the same reason.
  - Admin health: per account last sorted / last draft / last morning email; a System box that
    inverts to "Background jobs look stopped" when no working mailbox synced in 25 min
    (20 until wave 2 merge A).
  - Instant loading placeholders (`loading.tsx` → `ScreenSkeleton`) on queue, inbox, quotes,
    activity, settings only. **Never** on /admin or /customers/[key]: streaming turns `notFound()`
    into a 200, and those must 404 (e2e caught it).
  - Nav: bottom tab bar on phones, the same links in the header from `sm` up; `(app)` layout pads
    the bottom on phones. (Since 2026-10-16 five tabs: Queue · Inbox · Quotes · Money · More —
    see "The app on a phone".)
- **Text alerts (2026-10-09, plan #50; Davi: texting included in plans):** `src/server/sms-alerts.ts`,
  `src/lib/sms.ts` (Twilio over fetch, off without env). Owner's own US mobile, confirmed by a
  6-digit code (sha256 stored, 10-min expiry, 5 codes / 10 guesses per hour). Content-free counts +
  link, quiet 9pm–7am local, ≥10 min apart, ≤10/day, only fresh (<24h) inbound quote requests /
  needs_owner threads classified after the cursor; slot claimed atomically before sending. Runs
  after classification and in the 15-min lifecycle backstop. **Missed-call text-back dropped**: it
  would auto-text customers, which the feature plan forbids (no send path without approval; owner
  can't text customers).
- **Davi 2026-10-09 on the plan:** #4 voice-to-edit yes, with a plain note that the browser sends
  speech to Google/Apple; #10 offline approvals only as an opt-in setting; #46 evals on demand /
  before release, not nightly.
- **Plan M4 (2026-10-10):** #39 checklist (`src/server/onboarding.ts`, pure `buildChecklist`):
  Connect Gmail / Tell us what you do (`business_profile.completed_at`) / Check your first 3 drafts
  (sent, discarded or edited); on the Queue; "Hide this list" only when all done (server re-checks,
  `onboarding_dismissed_at`); it comes back if a step un-does. #23 `business_profile.never_say`
  (owner list, apart from the learned voice so a re-learn can't drop it; `src/server/never-say.ts`):
  Settings textarea + draft editor "Never say this" on the selected text (a button, since a textarea
  long-press can't host a custom menu). `checkDraft` now returns `hits`; never_say / never_promise
  hits → **one** regenerate (`REGENERATE_ON`), then flags (cap 0.2). #25 `seasonal_notes` table
  (text ≤140, `ends_on` local date, ≤5 active, ≤1 year ahead; codes past/too_far/full),
  `activeNotes(now)` in the owner's time zone; only active notes go into `draft.v4`'s cached block
  and count as source text for checks; expired rows purged daily. `draft.v4` adds both lists.
- **Plan M5 (2026-10-10, branch `claude/milestone-5-drafts`; brief M5 was already built, no R-items):**
  - #43/#2/#1/#8: `checkDraft` also flags guarantee/warranty/promise words ("commitment") and
    "N dollars"; one regenerate on money/when/never_promise/never_say hits. Typed gaps
    `{{price}}` `{{date}}` `{{time}}` `{{custom:label}}` (`src/ai/gaps.ts`) shown as fill-in chips;
    the server refuses to send with any `{{`/`}}` left (also autopilot). `draft.v5` returns
    `used_facts` (keys) for "Why this?". Labels Ready / Check the details / Check everything
    (`src/config/drafting.ts`); flags or gaps never read Ready.
  - #3/#4: `reviseDraft` + prompt `revise.v1` (tweak chips, and "Tell it what to change" typed or
    hold-to-talk via the browser's Web Speech API, hidden where unsupported, with the
    Google/Apple note). Same checks as a new draft; a **flagged** draft's text never counts as
    source (a tweak can't launder a flag); spoken words do. Max 5 per draft, 40/h per workspace.
    Clears any autopilot countdown. Log `draft_revised` {via} only.
  - #7 undo send: drafts stay `pending` with `send_after` (no new enum value — adding one and
    using it in the same migration run is unsafe) and are hidden from the queue. `queueSend` runs
    every check at the tap (403 unchanged), job `send-after-undo` → `deliverQueuedSend` claims
    atomically (`send_claimed_at`, 2-min lease) and re-runs the whole gate via
    `sendDraft(..., {queued: true})`; anything that stops it un-queues and logs `send_stopped`.
    Reconcile skips claimed drafts and a Gmail change un-queues. Backstop in the 15-min job. The
    API route now answers 202 `{status: "queued"}`. Autopilot still sends directly (its 10-min
    hold is its window).
  - #5 `/queue/review` + `batchSend`: rules in `batch-rules.ts` re-checked on fresh rows; each
    reply goes through `queueSend`. Categories picked per visit (`?cat=`), not stored.
  - #6 `threads.snoozed_until`; rules in `snooze-rules.ts` (owner's time zone, DST-safe);
    emergencies (priority high + needs_owner) only until midnight; back on top for 24h.
  - #9 two-way swipe (thumb side opens for sending, other side discards after a 5s Undo),
    `navigator.vibrate`. #9/#37/#10 are **per-device cookies** (`src/lib/device-prefs.ts`:
    `sa_hand`, `sa_contrast`, `sa_offline`) so each phone renders right on first paint.
  - #41 `/record/[draftId]` from draft row + activity log (`send_approved` carries device,
    undo window, offline). No loading.tsx there (must 404).
  - #21 `edit_signals` (counts/yes-no in code, tone via Haiku prompt `edit-tone.v1`), captured
    daily before the purge; weekly `voice-ideas` proposes ≤3 `voice_suggestions`; only a yes
    changes the voice profile (source → edited). Evals gained revise + tone cases.
  - #36 web push without a library or payload: VAPID JWT in Node crypto, empty push, the service
    worker fetches `/api/push/summary` (counts) with the owner's cookie. Endpoints allow-listed to
    real push services. Same throttle/quiet hours as texts (shared `freshLeads`). Off until
    `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` are set.
  - #10 offline okays (opt-in): SW keeps `/queue` + `/_next/static` only while cache
    `sa-queue-v1` exists; okays stored in localStorage with a sha-256 of the text seen;
    server refuses `changed_since_seen` / `intent_expired` (>12h). Signed-out screens and
    sign-out delete the copy.
  - #37 sunlight: tokens under `:root:has([data-contrast="high"])` in theme.css; header toggle.
- **Plan M6 (2026-10-11, branch `claude/milestone-6-8`):** #40 practice sends — `practiceSend`
  (`src/server/practice.ts`) only while `effectiveStatus === evaluating`, a NEW unthreaded message
  via `MailboxWriter.sendMessage` to the owner's own address, subject "[Practice] …", and
  `onlyToOwner()` re-checks To/Cc/Bcc on the exact MIME before Gmail; max 10 (`practice_sent` log).
  Real sends stay 403. #45 `/admin/costs` (`admin-costs.ts`, rules in `admin-cost-rules.ts`):
  revenue = plan price for setup_paid/active/past_due; alert email to `ADMIN_EMAIL` when AI cost
  > 40% of plan, once per account per month (marker in `app_settings`), daily in the purge job.
- **Plan M7 (2026-10-12, branch `claude/milestone-6-8`; #27 #28 #29 #30 #15 done, #26 behind a flag):**
  One additive migration (0023: `drafts.purpose`, `threads.quote_outcome_source` /
  `invoice_paid_at` / `invoice_paid_source` / `complained_at`, `business_profile.review_url`,
  `price_history`) plus hand-written backfills (legacy outcomes → source `owner`; 0024 marks
  threads still sorted `complaint`). Any `Date` in raw `sql` is `.toISOString()::timestamptz`.
  - **classify.v3** adds `signals.accepts_quote` / `signals.job_done`, stored as
    `extracted.accepts_quote` / `extracted.job_done`. `extracted.quote_accepted` is decided in code
    at classification: acceptance AND (the thread was a quote before this email, or is one now) AND
    the owner has written on it AND the owner gave a price before it (`quote_amount_cents` known, or
    a `$` figure in an owner email) — an acceptance is often re-sorted as scheduling; "Sounds good,
    book us in" after "I can come look Tuesday" is a site visit. A quote sent only as an attached
    PDF ("Quote attached") has no `$` we can see, so its "Let's do it" is not auto-won and gets no
    deposit draft; the owner can still tap Won (attachments aren't recorded at sync; see Waiting on
    Davi). Kept across later re-sorts until decided. `afterClassified` (auto marks) runs after
    `classifiedAt` is set, in a try/catch that logs metadata only; injection emails get no auto
    marks at all.
  - **Purpose drafts:** `drafts.kind` stays `reply`; `drafts.purpose` ∈ deposit / review_request /
    closing_question (`purpose.v1`). Purposes **never** autopilot, never batch, never earn autopilot,
    never bump `followup_count`. Autopilot and batch also refuse any draft whose email
    `accepts_quote` ("Quote acceptances always wait for you."). Deposit = the next draft on a thread
    with `quote_accepted`, once per thread; no payment terms → `{{custom:deposit instructions}}`
    gap + `NO_PAYMENT_TERMS_FLAG` first in the flags (survives the 6-flag cap), confidence ≤ 0.3.
    `checkDraft({ checkTerms })` (deposit + review only): a %, way to pay or discount/free/gift
    word not in the source → `terms` hit, one regenerate, then flag (cap 0.3); review requests
    also flag any URL other than the review link.
  - **#30 outcomes:** `quote_outcome_source` owner | auto — **the owner always wins**
    (`canAutoSet`; the auto UPDATE's WHERE re-checks it, uses `.returning()`, and only then logs).
    Auto-won on `quote_accepted`; auto no answer (`guessNoAnswers`, on Quotes load and a step in
    `followup-scan`) after 2 sent nudges + 7 quiet days, or 21 quiet days with fewer. A quote
    thread = category quote_request OR an outcome ever set. Lost / no answer stop all nudges; won
    stops quote nudges (a won job's invoice is still chased until paid). Auto guesses don't delete
    a waiting nudge — they add a "check before sending" flag; an owner decision expires it (and
    deletes its Gmail draft). Read-only accounts can't mark quotes (`?error=readonly`). Activity:
    "You won N of M quotes decided this month (P%)." (by `quote_outcome_at`, in the owner's month:
    `business_profile.time_zone`, Eastern by default, via `localMonthStart`; the Activity month
    label and month counts use the same zone).
  - **#27 `/money`:** invoice threads (`extracted.invoice`, or `invoice_thread` kept across
    re-sorts; facts carried when a later email has none or the same number), oldest due first.
    Excludes supplier_vendor and threads whose newest sender is a receipt domain
    (`RECEIPT_SENDER_DOMAINS` stripe.com / quickbooks.com / intuit.com). Owner Mark paid / Undo,
    "Not owed to me" (`invoice_paid_source = not_owed`, out of both lists) / Put back via
    `?show=hidden`. Auto-paid: a customer's same-thread "paid" (never from a receipt sender), or a
    receipt that names the invoice number (normalized; **no amount-only match**). A paid or
    not-owed invoice is never chased; owner Mark paid expires the waiting nudge and deletes its
    Gmail draft (`expirePendingNudge`), an auto-paid mark only flags it ("We think this was paid").
    A later email naming a different invoice number reopens the row: the paid mark (ours or the
    owner's) is cleared and logged as `invoice_reopened`. "Not owed to me" is never cleared, and
    injection emails never reopen.
    A3: a sent purpose note, any quote outcome or a paid invoice stops nudges, and the sent screen
    then promises none. `expirePendingNudge` claims the nudge in one conditional UPDATE (pending,
    Send not tapped) before touching Gmail or Activity: a Send tapped first wins, and a double
    "Mark paid" closes it once.
  - **#29 review request:** `business_profile.review_url` (https only). "Ask for a review" on Inbox
    rows and paid Money rows, owner tap only, when `job_done` or the invoice is paid. Never a
    complaint: `threads.complained_at` is sticky, and any complaint from that address in the last
    12 months blocks it. Never no-reply/receipt senders, supplier_vendor, injection/municipal mail,
    or an address the owner never wrote to (`knownCustomer`). One per address per 12 months,
    serialized by `pg_advisory_xact_lock` (`src/server/review-lock.ts`).
  - **#26 closing question:** built behind `FEATURE_CLOSING_QUESTION` (`src/config/features.ts`;
    on only for "1"/"true"/"on"; the code default stays off). **On since 2026-10-14** (Davi): `1`
    in Vercel on Production and Preview, live from the next deploy (the launch merge). Offer on Quotes after 2 sent
    nudges + 7 quiet days; owner tap only (never a job), once per thread ever (partial unique index
    `drafts_one_closing_question_per_thread`; a lost race returns `already_asked`/`already_pending`
    and deletes the extra Gmail draft); separate from `followup_count`.
  - **#15 price memory:** `price_history` (amount, kind of job, date; one row per thread) written by
    `captureQuoteAmounts` from the owner's own sent quotes (plus a one-off backfill of existing
    captured amounts); owner-typed Won amounts never go in. Similarity in code (job-word overlap,
    `SIMILAR_AT` 0.5, top 3). Shown only on quote requests ("Last 3 similar"): on Queue (tap a
    figure to fill `{{price}}`) and as plain text on Inbox. **Never sent to the AI** and never in digest/admin/push/SMS:
    a static boundary test lists the only files that may touch it, plus per-prompt tests. Kept
    past the body purge; goes with the mailbox / account.
  - Sentry: `ui.*` breadcrumbs lose message and data (`scrubEvent`). A failed query's bound
    values never leave: `scrubEvent` cuts every exception value (causes too), `message` and
    `logentry` at `\nparams:` and keeps only the first line of anything starting `Failed query:`. M7's new controls (Money
    cards, past-price buttons) use aria-labelledby or visible text, never an aria-label with an
    amount or name. Older labels (draft card, quote card, seasonal-note remove, admin waitlist)
    still carry a name or owner text and are kept out of Sentry only by the `ui.*` scrub.
- **Plan M8 (2026-10-12, branch `claude/milestone-6-8`; #31 #32 #33 #34 #35 #38 done):**
  Migration 0025 (additive, no backfill): `threads.quote_requested_at` (set once when a thread is
  first sorted quote_request, never cleared, like `complained_at`; the time is the customer's
  first email since the owner last wrote — "wrote" as in `lastOutSql`, see "Side conversations"
  below — so a new job asked for on an old conversation dates from the request; threads sorted
  as quotes by older code fall back to the thread's first inbound), `threads.job_kind` (one of our
  fixed labels, set at classification; only replaced while null or "Other jobs"; injection emails
  leave no mark), `threads.at_risk_alerted_at`, `business_profile.monthly_summary_last_sent_for`
  ('YYYY-MM'). Queries count a quote request as `quote_requested_at IS NOT NULL OR` the current
  quote rule (`quoteRequestSql`), so a request re-sorted as scheduling still counts.
  - **Queue numbers have one source:** `queueMembership` / `queueCounts` (`src/server/drafts.ts`)
    share listQueue's filter but select only ids, category, priority, kind and times, with no
    50-row cap. The digest, `/api/push/summary` and `/api/badge` use them, never `listQueue`. This
    also fixed the digest counting snoozed threads and sends still in their undo window.
  - **#31 Needs you:** up to 3, emergencies first then oldest waiting; waiting since = the
    customer's first email after the owner last wrote (owner wrote last → noun only, sorted last).
    Fixed category nouns (`digest-rules.ts`), never the needs-owner reason. Links are only
    `/queue`, `/settings#digest`, `/quotes` and `/queue#t-<uuid>` (allow-list test, no `@` or `?`).
    Queue cards carry `id="t-<uuid>"`. The (app) header isn't sticky, so cards use `scroll-mt-4`
    plus `scroll-mb-28` on phones (the bottom tab bar), and `ScrollToThread` scrolls a streamed card
    into view (the browser's own hash scroll fires before the card exists).
  - **#32/#33 week:** Monday 00:00 → Monday 00:00 in the owner's zone (`weekBounds`, DST-safe;
    pure date code lives in `snooze-rules.ts`: `localParts`, `localMonthStart/Name`, re-exported).
    `src/server/scorecard.ts`: replies and follow-ups by `decided_at`; quotes out = each quote
    request once, in the week of the owner's first answer; response time = the request time
    (`requestAtSql`: `quote_requested_at`, else the thread's first inbound) → owner's first answer
    (synced email that isn't a side email, sent draft, or a send in its undo window), calendar time,
    filed under the week the request came in, plus how many are still unanswered. No-reply senders
    (`src/server/sender-rules.ts`, SQL twin in `thread-sql.ts`) count as neither. Time saved =
    `MINUTES_PER_SENT_REPLY` (now in `src/config/drafting.ts`) × (replies + follow-ups sent).
    `monthSummary` now counts sent items by `decided_at` too, so a week can't beat its month.
    Activity: "This week so far" card with last week alongside; Monday's morning summary gets a
    "Last week" section (skipped if all zero).
  - **#34 leads at risk** (`leads-at-risk.ts`, rules in `leads-at-risk-rules.ts`): business hours
    are one default in `src/config/business-hours.ts` (Mon–Sat 7am–6pm, owner's zone; the free-text
    `business_profile.hours` is for drafting only and is **not** parsed), `LEAD_AT_RISK_HOURS` 4
    (`businessMinutesBetween`), `LEAD_AT_RISK_MAX_AGE_HOURS` 72 calendar hours (so the 30-day
    backfill can't flood alerts), `LEAD_AT_RISK_PUSHES_PER_DAY` 3. Answered = an owner email after
    waiting-since, a sent draft decided since then, or a send queued / claimed. Only mailboxes that
    are active and synced in the last 30 min count (a stale mailbox can't see the owner's replies).
    Snoozed, decided, out-of-inbox and no-reply leads are skipped. A push step in the 15-minute
    lifecycle job (after `m7-backfill`): inside business hours and outside quiet hours, claims the
    shared push slot (10-minute gap with new-lead pushes), marks each lead once per **waiting
    episode** (`at_risk_alerted_at < waiting since` re-arms it), counts the day's cap from
    `lead_at_risk_push_sent` activity rows; if no phone got it, the marks and the slot are handed
    back and nothing goes in Activity. The tap opens `/queue?t=<uuid>#t-<uuid>` (a real
    navigation; `sw.js` `safeUrl` allows only that or `/queue`), or `/quotes` when the lead has no
    queue card. The morning summary has the counts-only "N quote requests have waited more than 4
    hours." line, push or not (harmless catch-up), for leads with a card on the queue; leads with
    no card get only the Needs-you line linking to Quotes (Check 18 P8, wave 3).
  - **#35 monthly summary** (`monthly-summary.ts`, rules in `monthly-rules.ts`): a second step of
    the hourly `morning-digest` job; follows `digest_enabled`; due on local day 1–3 **at/after**
    `digest_hour` for the previous month in the owner's zone; Resend idempotency key
    `monthly-<workspace>-<YYYY-MM>`; marker set only after a send (no Resend env → nothing sent or
    marked); quiet months and read-only accounts get none. Contents: quote requests, top 3 job
    kinds (`src/config/job-kinds.ts`, per trade, whole-word keyword match on the model's
    `service_requested`, "Other jobs" fallback — only the label is stored or sent), top 3 lead
    sources (`src/config/lead-sources.ts`; domains split in SQL so no address reaches JS; Google
    only as the exact hosts `localservices.google.com` / `business.google.com`; facebookmail.com
    left out as too broad; else "Direct email"; the domain is the requester's,
    `requestSenderSql`), quote requests by `requestAtSql`, repeat customers (an address with a
    **new** request in the month — a conversation that began in the month or a quote asked for in
    it — and an earlier inbound on a **different** thread before the month, one SQL count; one job
    split over two September threads that carries on in October is not a repeat) and win rate
    (`closeRateBetween`).
  - **#38 badge:** `src/lib/app-badge.ts` + `AppBadge` in the (app) layout fetch the count-only
    `/api/badge` (`{ count }`, 401 signed out) at most once a minute, after a queue action and on
    becoming visible; `sw.js` sets it after a push. Count = replies ready + needs-you, capped at 99,
    0 for read-only accounts. Cleared at 0, on a 401 and on signed-out screens; a network error
    leaves it alone. True lock-screen widgets aren't possible for a web app (no API for them).
  - Logs: `console.error('<event>', { ids, error: err.name })` — never `err.message` (Stripe
    errors echo customer ids). `*-rules.ts` files never import `server-only` or `@/db` (test).
- **Website-form leads reach the customer (2026-10-16, outside review "Must fix", B1 + H7):**
  forms (Squarespace, Wix, WordPress, Jobber / Housecall Pro) email from a robot with the
  customer in Reply-To; drafts used to go to From ("Reply sent." to a robot). Migration 0028
  (additive): `messages.reply_to_header` jsonb — NULL = never read, `{}` = read / nothing usable
  (reply to From), `{address, name?}` = reply there. Chosen once at sync by `pickReplyTo`
  (`src/server/reply-address-rules.ts`, pure): well-formed, not any workspace mailbox nor its
  business domain (webmail exempt), not no-reply, **not a lead platform relay** (Thumbtack / Angi
  relays stay platform leads, `leadPlatformOf`), not From itself; first usable wins. Metadata
  reads ask for Reply-To; `MailMessage.headers.replyToRead` is true only when the request could
  return it, so a subset read stores NULL, never `{}`. ONE helper: `customerReplyAddress` /
  `customerReplyName` (TS) and `replyAddressSql` / `replyNameSql` / `messageReplyAddress` /
  `customerAddressSql` / `waitingReplySql` / `requestReplySql` (SQL twins, `thread-sql.ts`).
  **Reply address** = drafts (every kind), screen names (Queue, Inbox, Quotes, Money,
  Customers, Activity), customer grouping, known-customer / review eligibility, no-reply
  exclusions (leads at risk, scorecard, repeat customers), complaint memory (both addresses),
  first-time sender (new From OR new reply address) and VIP (either). **From** stays for
  identity: receipts (`isReceiptSender`, also on the reply address in Money), building
  departments, the monthly lead-source label, the classifier's "Sender:" line (no prompt change).
  Never in an alert, URL, push, SMS, digest, admin or log. Drafting a thread whose customer row
  is NULL reads Reply-To first (one metadata call, before any model call); 404 → `{}`; any other
  failure never falls back to From (jobs rethrow → `politely()`; the owner's tap gets
  `?error=gmail_busy` / `reply_to_unread`). A no-reply `to`: skipped for every trigger
  (`no_reply_address`; round 2 made the owner's tap skip too) and `sendDraft` / `queueSend`
  refuse it; `NO_REPLY_FLAG` stays only for older drafts (kept through tweaks). **Autopilot** checks `knownCustomer(draft.toAddress)` and refuses any
  draft whose To isn't the customer's From ("goes to a different address…") or whose customer
  row was never checked — a Reply-To never unlocks autopilot. H7: "To: address" on every draft
  card and the edit screen ("the reply address in their email" when redirected), on
  /queue/review rows and /record. One-shot job `reply-to-backfill` (own Inngest function, every
  15 min, concurrency 1, one step per mailbox; `app_settings` `backfill:reply-to-v1[:<mailbox>]`):
  inbound inbox mail of the last 30 days with NULL, newest first, Reply-To only, 2 at a time,
  100 / 20 s per mailbox per run; skips inactive / read-only / still-syncing mailboxes (no
  marker); 400/404 → `{}`. Pending drafts addressed to a robot whose form email now has a
  Reply-To are **re-pointed, not expired** (expiring would drop the lead from the Queue): Gmail
  draft rewritten first (same text; skipped if the owner changed it in Gmail — text or message
  id), then the row with `REPOINTED_FLAG` first and the countdown cleared; Activity
  `draft_repointed`. Replies sent in the last 30 days to a robot get one Activity line
  `reply_went_to_form` (links to its record). e2e: `tests/e2e/form-lead.spec.ts` (fake Gmail
  serves Reply-To; metadata reads return only the named headers).
- **Round 2 trust + trades (2026-10-16, branch `round2-fixes`; reviews "Trust Check" R2-A and
  "Trade Walkthrough" R2-B):** prompts `classify.v4`, `draft.v6`, `followup.v4`, `revise.v2`;
  eval set 109 cases (new metrics paymentChangeRecall / gasSmellRecall strict, billDirection,
  routinePaperwork). Migration 0030 (additive): trade enum `remodeling` (ADD VALUE),
  `workspaces.extra_trades` text[] (≤2, `cleanExtraTrades`).
  - **Attack guard** (`src/ai/guards.ts`): base64 only in space-free runs mixing case + digits,
    links stripped first; emoji joiners and flag tag sequences aren't "hidden"; Unicode tag
    characters are. New phrasings: "ignore the above", "dear AI assistant", "note for the
    automated system", "when drafting your response", "if an AI is reading", Spanish /
    Portuguese. Marks stick: `injection` / `payment_change` carry across re-sorts
    (`sticky`), every older unsorted email of the thread is checked in code (`alsoCheck`), and
    `createDraftForThread` re-checks every inbound email it would show the model (jobs only).
  - **Bursts (B4):** unsorted emails from the same sender ≤30 min before the newest (max 4) go to
    the model with it (`emailBlock.earlier`); older ones are marked classified only once their
    thread's newest is sorted, in the same write.
  - **Draft checks** (flags only, never rewrites): money in any form via `src/ai/money-words.ts`
    (1.2k, twelve hundred, a grand, ranges, /hr, bare "is 1500" = weak: also allowed if the number
    appears anywhere in the sources); loose timing (today, ASAP, in an hour, the 3rd, end of week,
    first thing, between 8 and 10); soft promises/admissions (`soft_promise`, cap 0.5, no
    regenerate); a % the owner never wrote (money); `customer_amount` (cap 0.5, no regenerate)
    when a draft repeats an amount only the customer named — needs `ownerSourceText` (owner
    emails + profile). The owner's spoken tweak (`ownerInstruction`): every number in it is
    theirs. `hasUnfilledGap` also blocks `[price]`, `[Customer Name]`, `$___`, `$X,XXX`.
    Autopilot's money test = `mentionsMoney`.
  - **Robots (A9):** no-reply pattern widened (token anywhere: voice-noreply, form-submission,
    wordpress, postmaster, bounces, automated, auto-reply); never drafted (any trigger), never
    sent, never a row on Customers.
  - **Payment change (A11):** code rule + model signal → needs you, priority high,
    `PAYMENT_CHANGE_REASON` ("Call them at a number you already have…"); no job draft, no
    batch, no autopilot. **Gas (TW B4):** rule + signal → high, needs you, `GAS_SMELL_REASON`;
    the draft job writes ONE fixed `safetyNote` (purpose `safety`, no model,
    `SAFETY_NOTE_FLAG` first) per thread; the owner taps Send like anything else.
  - **Autopilot (A10, stricter):** refuses any customer (sender or reply address) who
    complained or disputed in the last 12 months (`customerComplainedRecently`, same memory as
    review requests), and payment-change / gas threads.
  - **Claims (TW A1):** `signals.routine_paperwork`; the legal mark drops only when the model says
    paperwork AND `mentionsRealLegal` finds no lawyer / court / sue / lien-on-the-house / dispute
    word. No complaint mark then. **Money direction (TW A2):** `extracted.invoice_direction`;
    `extracted.bill_direction` (this email's, else the stored one) = `owed_by_business` keeps a
    thread off Money owed and out of follow-ups. **Towns (TW A5):** `looksMunicipal` adds
    `<town>.<st>.us`, inspectors of wires / plumbing & gas, fire prevention, boards of health,
    conservation / historic commissions, zoning / planning, "City of X via OpenGov", portal
    domains.
  - **Drafter's clock (A8):** `conversationBlock({ now, timeZone })` starts "Today is …" and
    stamps each email in the owner's zone. **Trades (TW A4, D1):** Remodeling trade + prompt +
    job kinds; extra trades merge words/questions (draft.v6), go to the sorter's business block
    and `jobKindsFor`. Keyword fixes: no bare "stain"/"heater"; roof replacement before gutters;
    "Snow and plowing" apart from "Cleanups" (old stored labels are recomputed).
  - **Outages (D4, D5, C6, C7):** a failed provider call (5xx, 429, 408, no connection) refunds
    its cap slot; a cap refusal never leaves the count above the cap. The 15-minute lifecycle job
    re-sorts mailboxes with mail unsorted 10+ minutes (`unsortedSweepMailboxes`, skips capped /
    read-only / inactive). `AssistantBanner` (every signed-in screen, counts only): limit used
    up (and when it restarts, owner's clock), "N new emails aren't sorted yet", 80% warning.
- **Round 2 first week (2026-10-16, branch `round2-fixes`; review "First Week" R2-C, Growth G3,
  Trust Check privacy lines):** migration 0031 (additive): `threads.handled_offline_at`,
  `invites.test_user_added_at`, `business_profile.first_look_hidden_at`. Pure rules and wording in
  `src/server/first-week-rules.ts`; DB side in `first-week.ts` and `invite-email.ts`.
  - **"I called them" (E11):** on draft and needs-you cards (`queue/called-them.tsx`, confirm
    step). Sets `handled_offline_at`, expires the waiting draft (`expirePendingDraft`, claim
    first, Gmail draft deleted). `lastOutSql` = greatest(owner email, the call), so every "who
    wrote last" read counts the call; `answeredByPhoneSql` (call ≥ newest inbound) keeps it off
    follow-ups, auto drafts and Needs you; `createDraftForThread` skips it for jobs; the
    scorecard's first answer counts it. The customer writing again undoes all of it.
  - **E9:** every card says "Wrote N days ago" (`QueueItem.customerWroteAt`, newest inbound).
  - **Setup (C1/C10):** required three marked "(required)", the rest folded under "More
    details, optional" on /welcome/profile only (opens if one needs fixing); the setup form sends
    the browser's time zone (`businessProfileInput.timeZone`, bad zones dropped). The sent
    screen's "I'll nudge Dana on Thursday" uses the owner's zone. Connect page says "Step 1 of 3"
    on a first connect; the queue shows one big Connect Gmail before anything else.
  - **D1/D2:** "Your last 30 days" card on the queue for 7 days after the first read (accounts
    under 14 days old only, `NEW_ACCOUNT_DAYS`; Hide this), and on the learning screen. Counts:
    emails read in the 30 days before the first read, conversations sorted in the last 14 days by
    category. Found money = quote requests waiting with no draft + answered quotes quiet past the
    follow-up wait with no nudge sent; "Draft them" (once, `app_settings`
    `found-money-drafted:<ws>`) enqueues `found-money-drafts` (owner-trigger replies, follow-up
    trigger nudges, ≤10). Drafts only.
  - **D4:** `sendFirstDraftsReady` (after drafting + the 15-min job): once ever per account
    (`first-drafts-ready:<ws>`), new accounts whose inbox was read in the last 3 days, voice done,
    a draft waiting; email + any phone push; counts only.
  - **Trial (E6/E7/F2):** practice copies tick "Check your first 3 drafts" (each draft once);
    read-only accounts get "Choose a plan to keep going" instead. Last 24 hours: inverted banner
    with sorted/drafted counts and a Choose a plan button; expired banner says what's waiting
    (counts). Expired wording: "Choose a plan to switch sending on" / "Sending turns on once you
    choose a plan". Push says "ready to check" unless the account can send.
  - **Billing:** each plan card shows the first charge from config (`firstChargeLine`: plan +
    setup when due, plus tax, then monthly). Paid + setup call pending → "What happens next" on
    /billing. **K7:** `notifyPaymentReceived` emails ADMIN_EMAIL once per checkout session
    (content-free: plan + setup yes/no; marker `payment-notice:<session>`), never fails the webhook.
  - **Invites (A1/A4):** `sendInviteEmail` after a new invite (form or waitlist): sign-in link,
    10 minutes, what to have ready; once per invite (marker keyed by a salted hash + invite time),
    skipped once accepted, never fails the invite. /admin invite rows show "Add … as a Google test
    user" + "I added them" (`test_user_added_at`).
  - **Wording:** terms box label has no links (tapping the words ticks it; "Read the Terms of
    Service" / "Read the Privacy Policy" sit below); the terms screen's way out names only what
    this person has (`leaveOptionsLine`); FAQ no longer says "send from either place"; Growth's
    "Book a free call" is "Ask Davi to call me" everywhere (it's a callback request).
  - **Privacy (TC):** breach notice (MA 93H), processed in the US, sender + subject go to the
    AI, the one-line reasons are kept past the purge, voice-example placeholder wording made
    true, the new emails and the payment notice named. Both documents and `TERMS_VERSION` moved
    to 2026-10-16 (the same date review-fixes uses), so everyone agrees again once. /privacy
    tables are focusable regions; `src/app/favicon.ico` exists.
- **The app on a phone (2026-10-16, outside review P3; I4, K1):**
  - Theme: `--input` is slate (≥3:1 on paper / off-white; `tests/unit/input-contrast.test.ts`
    checks every look); native checkboxes / radios take `accent-color: var(--primary)` in
    globals.css (never the browser's blue).
  - Draft card: the five tweak chips and "Tell it what to change" sit behind one **Change it**
    button (`aria-expanded`); the row is Discard · Change it · Edit (Edit on the thumb side,
    mirrored for left hands). The editor no longer holds the rewrite box. e2e checks Send reply
    is fully on screen, above the tab bar, for a typical draft at 375×812.
  - **Settings is a list** (`/settings`, `MenuList` rows ≥56px with a one-line state) of
    screens: `/settings/gmail`, `business` (profile facts + seasonal notes), `writing` (voice,
    ideas, never-say, Re-learn **behind a confirm**), `follow-ups`, `autopilot`,
    `morning-email`, `notifications` (only with VAPID keys), `texts` (only when
    `smsConfigured()`; both screens redirect to the list otherwise — no "Coming soon"),
    `phone` (Get the app, hand, offline queue), `account` (Plan & billing link, Sign out —
    the inline action moved here whole — and Delete my account), plus `/billing` and `/admin`
    (admin only). Each screen's notices live in `settings/messages.ts` (`SCREEN_MESSAGES`);
    every action redirects to its own screen (`tests/unit/settings-screens.test.ts` checks
    every `?done=` / `?error=` code has a notice and a page). Old `/settings?done=…` bookmarks
    still show on the list (`LIST_MESSAGES`). Old anchors (`/settings#digest` …, 12 ids) are
    sent on by `LegacySettingsAnchors` (`legacySettingsScreen`, a switch of fixed paths).
    Emails now link `/settings/morning-email`; the access-lost email links `/settings/gmail`.
  - Switches save themselves: `AutoSaveForm` (`src/components/forms/auto-save-form.tsx`) is a
    plain server-action form; once hydrated, a checkbox / radio change calls `requestSubmit()`.
    Forms with only switches (`hideButton`: the hand radios, the offline checkbox) hide their
    Save button after hydration (`form[data-autosave] .sa-autosave-button`); forms with a
    `<select>` (follow-up days, digest hour) keep a visible Save (WCAG 3.2.2). Without JS every
    form still saves with its button (e2e with `javaScriptEnabled: false`). Auto-saves land on
    `?done=saved` → "Saved." ("Saved for this phone." on the phone screen).
  - **Five tabs:** Queue, Inbox, Quotes, Money, More (`src/config/nav.ts`: `currentTab`,
    `MORE_PATHS` — More is current on /more, /customers, /activity, /settings, /billing,
    /admin, /record); labels 14px; the sm+ header shows the same five. `/more` lists Customers,
    Activity, Settings (+ Admin for the admin); it's in the proxy matcher and robots.
  - **Activity leads with money** (`monthMoney`, rules in `activity-rules.ts`): "Won and paid
    in {Month}" — quotes with outcome won this month (owner or guess) summed from
    `quote_amount_cents`, and invoices marked paid this month (`owner` / `auto`, never
    `not_owed`) after a **sent** follow-up decided before the paid mark, summed from
    `extracted.invoice.amount`; items without an amount are counted and said. Never reads
    price history. Time saved stays underneath. The feed is grouped by the owner's day
    (`groupByDay`: Today / Yesterday / "Monday, Oct 13").
  - **Inbox:** each row says "Replied" / "Waiting on you" (`replyState` from `lastInSql` /
    `lastOutSql`; junk gets none); on All, junk folds into one "N junk emails" `<details>`;
    a client search (`inbox-search.tsx`) filters by name, address, subject, summary and
    category — typed text never reaches a URL or the server.
  - Onboarding ends on "Go to my queue" (`/queue`).
- **Ideas "control" package (2026-10-16, branch `ideas-build`; H3, H4, G7, E7 built; G3 and B7
  not built in this pass, see Waiting on Davi):** migration 0033 `control` (additive; was 0032 before the leads merge): `owner_sender_rules`,
  `customer_notes`, `threads.category_manual` / `category_manual_at`, `business_profile.away_back_on`,
  `seasonal_notes.away` (+ partial unique index, one away note). No prompt change.
  - **H3 sender rules** (`sender-rule-store.ts`, pure `owner-sender-rule-rules.ts`; the store is
    not called `*-rules.ts` because the purity test scans that suffix): Always junk / Never draft
    (address or company domain) and company-wide Always needs me; "Always needs me" for one
    address writes the VIP list instead (one list for that fact; DB check refuses an address
    `needs_me`). Keyed only from an email whose Reply-To was read (`keyFromMessage`: NULL header,
    lead-site relays and no-reply addresses refused). **Direction:** caution (VIP, needs me, never
    draft) matches From or the reply address; junk only when From matches and there is no redirect
    or the reply address matches too; a NULL header never junks; any caution beats junk. The
    junk shortcut (no model call, `extracted.sender_rule = "junk"`) is skipped for a moved
    thread, municipal senders, injection text, sticky marks and a whole-word guard list (lawyer,
    refund, leak, damage…). Junk refused for anyone the owner wrote to, a VIP, an open quote or an
    owed invoice, building departments; company rules never on webmail or the owner's domain; cap 200. Never draft is read live in `createDraftForThread` (jobs only, the customer's newest
    non-side email) and the auto-draft / follow-up scans skip `sender_rule = no_draft`. Inbox
    rows carry "Rules for this sender" (posts the email id, never the address); Settings → Sender
    rules lists and removes. Activity `{action, scope}` only.
  - **H4 Move it** (`resort.ts`): `category_manual` wins in classification's UPDATE
    (`coalesce(category_manual, model)` in SQL, race-safe); the model's own kind is stored as
    `extracted.model_category`. To complaint: needs you + sticky `complained_at`. To junk:
    discards the waiting reply (refused while it's in its undo window). To quote: request time =
    first customer email after the owner's last real reply. **Decision:** `quote_requested_at` is
    set once and never cleared, _except_ by the owner moving an undecided quote away (also
    clears `job_kind` and `quote_accepted`, withdraws a waiting deposit note). A job never drafts
    on a moved thread whose `model_category` isn't auto-draftable (`owner_moved`); autopilot
    refuses manual ≠ model ("You chose this kind yourself…") and such sends don't earn.
  - **G7 private notes** (`customer-notes.ts`): ≤200 chars, one per customer reply address, saved
    from the customer page (key = an email id), shown on Inbox rows and Queue cards (drafts keyed
    on `to_address`, others on the newest non-side inbound). Never sent to the AI or anywhere else
    (boundary test in `control.test.ts`). Not encrypted (like bodies; only tokens are). With the
    offline queue on (`sa_offline`), cards say "Note saved · Open" without the text. Goes with
    the mailbox it was written under.
  - **E7 away mode** (`away.ts`, pure `away-rules.ts`, `/settings/away`): day back after today and
    ≤90 days, read at use (no cron); one `away` seasonal note "Away until … (Oct 9). Back …
    (Oct 10)." (both date forms so `checkDraft` sees the date as given), outside the 5-note cap,
    read-only on the business screen. Nudges pause (`threadsToFollowUp` → none, followup trigger
    → `away`). Autopilot, alerts and the digest don't change; the screen's last line says so
    when autopilot is on. A default-zone owner's browser zone decides "today" and is saved.
  - Privacy policy (same 2026-10-16 date as `TERMS_VERSION`, so no new re-agree): what you tell
    us (rules, VIPs, notes, away day), the moved-kind record, notes/rules never sent to Anthropic
    and the junk-shortcut exception, retention, and notes left out of the offline copy.
- **Ideas "numbers" package, part (2026-10-16, branch `ideas-build`; C8, H8, C5, K2 built;
  D4 and D7 not built, see Waiting on Davi):** migration 0034 `numbers` (additive; was 0033 before the leads merge): `threads.quote_lost_reason`.
  No prompt change; nothing new is sent to the AI or to a customer.
  - **C8 quote speed** (`quoteSpeed` / `quoteSpeedSentence`, `scorecard-rules.ts`): of the week's
    quote requests, answered within `QUOTE_SPEED_HOURS` 24 calendar hours (nights and weekends
    count; the Activity explainer says so) out of those that can be judged: answered ones plus
    unanswered ones already over 24 hours; owner-settled ones left out. Percent from 5. Same
    request set and exclusions as response time. **Known edge:** Monday's email counts last week
    at send time, so a late-Sunday request still in its first day is left out of it (never
    marked slow early); the Activity card counts it later.
  - **H8 sent without changes** (`asWrittenSentence`, query in `scorecardQueries.asWritten`):
    replies + follow-ups sent from the app this week (`sent_gmail_message_id` set, so a
    reconcile-"sent" draft counts in neither number), never autopilot (`reply_sent.detail.autopilot`),
    and drafts that had `{{gaps}}` left out of both: `sendDraft` now writes `hadGaps` (yes/no)
    into `reply_sent`; older rows fall back to `original_body` and drop out once purged. Shown
    from 5 sent, "up/down from" only when last week also had 5; a link to
    `/settings/autopilot` where autopilot can be had (no claim that it earns autopilot). Both
    lines go into `scorecardLines`, so Monday's email has them (counts only; `ScorecardNumbers`
    fields are optional for older callers).
  - **C5 why you lost it** (`setLostReason` in quotes.ts, rules in quote-rules.ts): Price /
    Timing / Went with someone else, one optional tap on a Lost card; any new outcome clears it;
    read only through `shownLostReason` (old code can leave a stale reason on a reopened quote).
    Activity: "Lost this month: …" (`lostReasonsBetween`, the owner's month, by
    `quote_outcome_at`). Activity row `quote_lost_reason {reason}` is hidden from the feed.
  - **K2 which lead sources pay** (`lead-pay.ts`, `leadPayRows` / `leadPaySentence`): Quotes
    card "Where your work comes from", last 90 days (`requestAtSql`), only the requester's
    domain leaves SQL. A no-reply From with a different Reply-To is "Website form". Lead sites
    (`leadPlatformOf`) count Won only when the owner marked it and never say "0 won" ("Tap Won on
    Quotes…"). ≥2 sources to show, 6 rows max ("Everywhere else"). Owner-only.
  - Privacy policy: why a quote was lost (store + retention), same 2026-10-16 date.
- **Replies package (2026-10-16, branch `replies-build`; Davi's answers that day):** migration
  0037 `replies` (0035 on its branch; additive: `drafts.opening`, `threads.emergency_alerted_at`,
  `business_profile.emergency_alerts_enabled` default true). Prompts `draft.v7`,
  `opening-tweaks.v1`; eval set +12 first-contact cases, +3 revise cases, metric
  `openingAccuracy`. **The eval baseline is still empty** (no `ANTHROPIC_API_KEY` repo secret).
  - **Warm first replies (draft.v7):** draft.v6's rules plus a "First contact" section, used only
    when the code says so: `isFirstContact` (`first-contact-rules.ts`, pure) = an ordinary reply
    (no nudge, purpose note or gas safety note) on quote_request / customer_question /
    scheduling, no "I called them" on the thread, and `ownerWroteBefore`
    (`known-customer.ts`) false — no non-draft, non-side owner email on this thread or to the
    customer's reply address (never the From: a form robot is shared by every lead) from **any**
    of the workspace's mailboxes, and no app send to them (sent, queued or claimed). Asked only when everything else already says first
    contact. The task line `FIRST_CONTACT_TASK` tells the model; it picks `opening` details /
    vague / urgent / price_only (`not_first` otherwise) via `replyDraftSchema` (draft.v6's
    schema + `opening` with `.catch("not_first")`: a bad value never loses the draft; the SDK
    puts enums in the description, so nothing enforces them at the API). Stored only on a first
    contact (`storedOpening`; the model's "not_first" there is kept, so non-null = code said
    first contact). The business block, conversation block and date helpers are re-exported
    from draft.v6 unchanged (cache and nudges untouched); nudges keep `draftSchema`. Purpose notes
    now use v7's instructions (evals too). `checkDraft`, regenerate rules and gaps unchanged.
    v7 still bans "Thank you for reaching out" (checkDraft's filler); the warm opener is
    "Thanks for reaching out". Activity `draft_created` gets `firstContact: true`.
  - **Card:** "First reply: asks 2 questions · they described the job" (`openingLine`, counts
    `?` runs in the current text) and **Other ways to reply** (`OtherWaysToReply`, below the
    Discard · Change it · Edit row so Send reply stays put): Ask a few questions / Offer to come
    take a look / Short and friendly (`OPENING_TWEAKS`, labels mirrored in
    `OPENING_TWEAK_LABELS`, a test keeps them equal). `reviseDraft({ opening })` = revise.v2's
    instructions + the fixed ask, logged `revise.v2+opening-tweaks.v1`, same 5-per-draft / 40-an-hour
    limits; refused (`not_first_contact`, before any model call) unless the stored opening is one
    of the four shapes on a plain reply. Hidden on read-only accounts (`offersOtherWays`).
    **Autopilot refuses any draft with an opening** ("First replies to new customers always wait
    for you."): Davi said no to instant replies to new leads, and an old forward could make a
    new lead look known.
  - **Money in the morning email:** `moneySoFar` (activity.ts) → `moneySoFarLines`
    (activity-rules.ts): "This month so far: $X in quotes you won · $Y in invoices paid." and
    "Still owed to you: $Z on Money owed.", plus Activity's own note (`MONEY_SO_FAR_NOTE`). Won =
    `quote_outcome` won (owner or guess) by `quote_outcome_at` in the owner's month, from
    `quote_amount_cents`; paid / owed = `invoiceTotals` (money.ts) on Money's own rows
    (`moneyThreads`, now with `paidSince` so a 31-day month reaches past the 30-day paid list):
    no supplier bills, receipt senders, bills the owner owes or "Not owed to me". Items with no
    amount are counted and said. Zero parts left out; no section when all zero; it never makes a
    quiet morning worth sending. Activity shows the same lines on its money card ("Nothing won or
    paid yet" only when neither). The M7 privacy test now allows the total line in the email
    (never a name, invoice number or due date); push and texts still carry no amounts.
  - **Emergency alerts (B5 part 2)** (`emergency-alerts.ts`, rules in
    `emergency-alert-rules.ts`): candidates = `inEmergencyLane` exactly (a gas smell counts via
    its urgency mark), needs_owner, in the inbox, mailbox on (`mailboxRunning()`: active and not
    plan-paused), never alerted, not snoozed, not injection, the customer's newest non-side email
    under an hour old **and already sorted**, its reply address not no-reply — **except** a
    voicemail / text-message email (`phoneMessageSenderSql`, the SQL twin of `channelOf` kind
    phone / phone_text; integration 2026-10-17) — unanswered (owner email / "I called them" / app send / undo
    window). One alert per run per owner covering every new emergency; caps 3 between 9pm and
    7am (from the night's 9pm, across midnight) and 6 per local day, counted from
    `emergency_alert_sent` rows; count + mark + Activity row in one transaction under
    `pg_advisory_xact_lock(hashtext('emergency-alert:<ws>'))`. Sent through the owner's push
    phones and verified text number; nothing reached → marks and row taken back. Takes the push /
    SMS slots (`push_last_sent_at` / `sms_last_sent_at`) without waiting for them, so ordinary
    alerts wait 10 minutes after it, and `freshLeads` leaves an alerted emergency out until a
    later email is sorted on it. Words: "An emergency email just came in. Open Squared Away."
    (push, via `/api/push/summary` while that alert is the newest push and < 30 min old,
    `emergencySummaryApplies`; the tap opens `/queue?t=<uuid>#t-<uuid>`) and "Squared Away: An
    emergency email just came in. Open: <deep link>" (text). Runs first in `alertsForMailbox`
    (after sorting) and in the 15-minute backstop. Read-only accounts never. Setting
    **Emergencies, even at night** (`EmergencySwitch`, one switch on both Notifications and Text
    alerts; `saveEmergencyAlertsAction` → `?done=saved` on the screen it came from); off = an
    emergency waits like any email. Activity "Let you know right away about an emergency email"
    (counts) and the switch's on/off row.
  - Privacy policy lines added (first-reply labels, emergency alert times, the switch, money totals
    in the morning email); same 2026-10-16 date as `TERMS_VERSION` (as the other 2026-10-16
    packages did, no new re-agree); `legal-docs.test.ts` holds them to the code. SETUP.md §6c
    names the emergency exception and a second A2P sample message.
- **Queue screen (wave 2, `w2-queue`):**
  - **Focus (Check 32 P1):** a card button that turns into a question moves focus into it
    (`QuestionLine`, `src/app/(app)/queue/focus.tsx`); Keep it / Never mind / Cancel / Escape put
    focus back (`useFocusReturn`).
  - **Keeping the owner's place (Check 9 P5):** forms carry `threadId` / `nextThreadId`
    (`CardTargets`); redirects carry `&t=<uuid>` (same card for refusals and saves; the next card,
    else the one before, else its own id, for send / discard / snooze / I called them / They said
    no / Already paid); the notice renders on that card. URLs keep a literal `/queue` prefix.
  - **After Send reply (Check 9 P5 + Check 32 P7):** `SentStrip` fixed above the tab bar, its
    line the page's h1, focus once on mount; `UndoSend` speaks "You have 20 seconds to undo." then
    "Time's up. Sending now."
  - **Right now (Check 9 P6):** `queueMembership` returns `now` (emergencies with or without a
    draft), a view onto needs-you / drafts, so counts are unchanged.
  - **Whole reply above Send reply (Check 9 P7)**; **once per card (Check 9 P12):** header = tag and
    summary, the reason in Why this?, `withoutCategoryPrefix` (`src/lib/card-words.ts`).
  - **Draft a reply (Check 9 P9):** `DraftReplyButton` ("Writing a draft…");
    `createDraftForThread` takes a 2-minute per-thread lease (`src/server/draft-claims.ts`,
    `app_settings` `draft-claim:<threadId>`, purged daily) for every trigger.
  - **Gaps (Check 9 P11 + Check 23 P8):** "Fill in N gaps to send" opens the first gap; quick
    changes post the card's text, used only when `filledGaps(saved, current)` proves only gaps
    changed.
  - **Warnings order (Check 23 P9):** `scoreDraft` orders fixed cautions, purpose flags, check
    flags, model notes; `capFlags` keeps 6 ("And N more things to check."); `betterAttempt` keeps
    the retry with fewer REGENERATE_ON hits (`draft_retry_kept {kept}`).
  - **Getting started (Check 9 P13):** `business_profile.onboarding_done_at`; a finished list is
    one line and hides itself 3 days later.
  - **Swipe (Check 9 P14)**, **Send together (Check 41 P2):** a scheduling draft that names a
    visit time (`namesAVisitTime`) is never batch-eligible. **Nudge cards (Check 21 P8):** "They
    said no" / "Already paid". **Headings (Check 32 P9/P11)**, **Edit (Check 8 P7/P9):** the tab
    bar hides while a text field has focus. **Words (Check 9 P15 / Check 48 P5):** the Hold to
    talk note names Google, Apple or Microsoft.
- **Quotes and Money (wave 2, `w2-quotes`):**
  - **One quote rule (Check 11 P1):** `quoteThreadSql` / `isQuoteThread` are twins (144-case twin
    test); `quoteRequestSql` is the same rule, so Quotes, Customers, follow-ups, the scorecard,
    the monthly summary, lead pay and leads at risk count the same threads.
  - **The quote amount (Check 11 P2 + Check 39 P3):** `readOwnerAmount` (quote-rules.ts) replaces
    "largest $ figure". `stripForAmounts` cuts a "--" signature, Outlook header blocks, a wrapped
    Gmail "On …" line and "Sent from my iPhone" (amounts only; the classifier's `prepareBody` is
    unchanged). Figures need digits right after "$", proper thousands commas. Dropped: rates,
    deposit, trip charge, guarantee, warranty, tax, "normally / was / not / save / budget",
    and program words (rebate, incentive, credit, loan, financing, Mass Save, HEAT Loan, …) — the
    saved price is before incentives. The last figure marked as the price → 'total'; the only
    figure → 'total'; two or more "Option …" figures → none; else the LAST figure → 'picked'.
    `threads.quote_amount_note` ('total' | 'picked'); 'picked' shows "Check amount" and never
    goes into price memory. `ownerGavePrice` / acceptance use the same reader, so "$95 per hour"
    alone isn't a price given.
  - **A corrected price replaces the first (Check 11 P3):** `threads.quote_amount_from`
    ('reply' | 'owner') and `quote_amount_at` (when the price went out). `captureQuoteAmounts`
    re-reads open quotes whose amount came from a reply and moves amount, note, time and the
    `price_history` row; a typed amount and a decided quote are never touched (the UPDATE
    re-checks both). "Save as won" with the prefilled amount unchanged stays the reply's price.
  - **Daily capture (Check 11 P4):** only quote threads with an owner email that still has text;
    the purge job pages every match by id (500); the Quotes screen keeps one page.
  - **30-day totals (Check 11 P5):** `quoteTotals` in SQL — Asked for by `requestAtSql`, Priced by
    `quote_amount_at` (else the owner's last email; a typed amount only when won), Won and the
    win rate by `quote_outcome_at` (exactly `closeRateBetween`'s rows).
  - **A site visit isn't a quote (Check 11 P6):** stage `replied` ("Replied, no price yet") when
    the owner wrote last without a price; it never goes quiet, and `guessNoAnswer` needs
    `priced`. Homepage `stageWords` use semicolons.
  - **Amount only on Won (Check 11 P7):** "Mark won" step (optional amount, prefilled) plus "Mark
    lost" / "Mark no answer"; `setQuoteOutcome` ignores an amount unless won; "Change amount" on a
    won card (`setQuoteAmount`, activity `quote_amount_changed {amountTyped}`). Decided cards say
    the day ("Won Oct 14", `decidedLabel`).
  - **Filters (Check 11 P9):** chips wrap, in the order Open, Waiting on you, Quoted, Gone quiet,
    Won, Lost, No answer; one line per stage under the list; "Last email 41 minutes ago".
  - **Supplier bills (Check 12 P4):** `billOwedByOwner` + SQL twin `billOwedByOwnerSql`: owed by
    the business when the sorter said so, or the direction is unknown and the newest sender has a
    `supplier_vendor` thread from the same business (domain; exact address on public webmail) or
    an exact-address "Not owed to me" mark. A clear `owed_to_business` and the owner's own mark
    win. Used by Money and follow-ups; addresses compared only in SQL. A receipt sorted owed by
    the business, or with no amount, never marks anything.
  - **No amount yet (Check 12 P5):** owed invoices with no amount show "Amount not stated", out of
    the total; `captureInvoiceAmounts` (on view, and daily step `capture-invoice-amounts`) takes
    the amount from the owner's own newest email on the thread (`readOwnerAmount`, never an
    inbound email), stored with `amount_source: "your_email"` ("From your email").
  - **Net terms (Check 12 P6):** `dueDay` reads "net 30", "within N days", "N days from …", "upon
    receipt"; unknowable starts → "No due date"; the card shows "Due Oct 31".
  - **Money card actions (Check 12 P8 + P9):** a pending draft → "A reply to Linda is waiting in
    your Queue." + "See it"; else, owner wrote last, a nudge left and no needs-you → "Draft a
    reminder" (the follow-up drafter, so it re-checks paid / not owed / caps and **counts as a
    nudge**). No big $0: "No open invoices found"; the total shows with "Counted from your
    email, not your books."
- **Settings and time zone (wave 2, `w2-settings`):**
  - **Money box (Check 15 P1):** "2,500" / "$2,500" save as 2500; blank is refused, never $0.
  - **Time zone (Check 45 P1 + 44 P5 + 15 P7):** `business_profile.time_zone_source` default |
    browser | owner. `ZoneCapture` (gated in the (app) layout) posts the browser's zone once while
    the source is `default` (`saveDetectedTimeZone`, activity `time_zone_detected`);
    `saveBusinessProfile` sets `completed_at` on conflict too. Setup's zone saves as `browser`,
    never over `owner`; /settings/profile never moves it. Settings → Morning email has a visible
    "Your time zone" select and "Use Central time" when the phone differs (saves at once;
    `setOwnerTimeZone` → `owner`, logged `time_zone_changed {from, to}`). Playwright runs every
    page with `timezoneId: "America/New_York"`.
  - **Plain errors (Check 15 P2):** every profile rule has its own message (tested against Zod's
    wording); "People who always need you" takes Gmail-style pastes.
  - **Ways back (Check 15 P3):** `BackLink` / `CancelLink` on the two edit screens.
  - **Every fact (Check 15 P4):** `describeProfileFacts` (pure) lists every saved fact with
    "Not set." and a Change link to `/settings/profile#<field>`.
  - **Never-lists (Check 15 P5):** wording only; `saveNeverSay` reports skipped lines.
  - **Sign-off once (Check 15 P6 + 24 P11):** `signatureWithoutSignoff` drops a signature first
    line equal to the learned sign-off in `workspaceContext`; greeting / sign-off can be "I don't
    use one".
  - **Working days for alerts (Check 15 P8):** `business_profile.work_days` / `work_start_hour` /
    `work_end_hour` (defaults Mon–Sat 7–18) drive leads-at-risk; free-text hours stay for drafts.
  - **Reply language (Check 43 P8):** `src/ai/language.ts` `detectLanguage` / `chooseReplyLanguage`
    / `languageCardLine` / `languageMismatchFlag` / `replyLanguageLine`;
    `business_profile.reply_languages` (English always; Spanish / Portuguese switches);
    `drafts.customer_language` / `reply_language` (codes only); `checkDraft({ replyLanguage })`
    flags a wrong-language reply (cap 0.5, never regenerated). The prompt doesn't name the
    language yet (prompt-versions-inbox).
  - **Polish (Check 15 P9–P12):** seasonal-note dates via `src/lib/plain-date.ts`, Add note keeps
    what was typed, "1 email", per-trade `servicesExample`.
- **Follow-ups (wave 2, `w2-followups`):**
  - **Big invoices are chased (Check 12 P1):** `applyOwnerRules` returns `needsOwnerCode`
    (`extracted.owner_code`, an `OWNER_RULE_KEYS` value or "model"). `amountOnlyNeedsOwner` /
    `amountOnlyNeedsOwnerSql`: an invoice thread that needs the owner only for its amount (no
    manual, complaint, dispute, injection, payment-change or "is this a bot" mark) is still
    chased. Money's `chaseLine` says when nothing will be ("Not chased: this one needs you
    first", "…it's been quiet too long"). `FOLLOWUP_MAX_AGE_DAYS` lives in followup-rules.ts.
  - **A no stops nudges; "after the holidays" waits (Check 21 P2):** `threads.nudge_after` (start
    of the asked-for day in the owner's zone, replaced at every customer email; injection emails
    set nothing). `followupSignalsOf` reads `signals.declines_quote` / `extracted.wait_until`
    (inert until classify.v6). A decline on a quote thread → auto Lost (`DECLINED_FLAG` on a
    waiting nudge; the owner always wins). Quotes card / sent screen: "Waiting until Jan 4, as
    they asked."
  - **The owner's calendar day (Check 21 P3):** see Follow-ups (M7) above; `followupScanDue` /
    `markFollowupScanned` (`app_settings` `followup-scan:<workspaceId>`), `quietCutoff`,
    `nudgeDueDate`; the no-answer guess runs per due workspace in the same job.
  - **Invoices the owner sends (Check 21 P4):** `threads.owner_invoice_at`; `looksLikeOwnerInvoice`
    (pure, at sync, outbound rows, subject or first 2,000 own words; never a forward) sets
    `extracted.invoice_thread`. A fresh invoice is chased only when its first To address has
    written to the business before (`freshInvoiceToKnownSql`).
  - **Answered elsewhere (Check 21 P5):** no nudge when the customer's reply address wrote on
    another conversation after the owner's last email (`customerWroteElsewhere`); the newer card
    shows "Also about your quote from Nov 2" (`QueueItem.alsoQuote`).
  - **This quote's nudges (Check 21 P6):** `guessNoAnswers` counts only nudges sent after the
    customer's newest email; `MAX_FOLLOWUPS` (two per conversation, ever) unchanged.
  - **Service calls (Check 36 P3):** `isServiceCall` / `serviceCallSql`: an emergency the owner
    answered with no dollar amount isn't chased or guessed "no answer"; Quotes shows "Service
    call" (display only).
  - **Big quotes (Check 38 P4):** `business_profile.big_quote_days` (null = normal wait; 7/10/14/21);
    `FOLLOWUP_DAY_CHOICES` gains 10 and 14. `isBigQuote` / `chaseTiming` / `noAnswerAfterDays(n,
big)`; the hourly job runs `captureQuoteAmounts` first.
- **Autopilot rules (wave 2, `w2-autopilot`; Checks 20 P2 P13 P3 P8 P7 P6):** only stricter or
  clearer; no new send path; the three layers, the 10-minute window and the claim are unchanged.
  - **Unsynced mail (20 P2):** `MailboxWriter.threadMessageLabels` (threads.get format=minimal,
    ids and labels only) gives the owner's drafts and the thread's mail in one call;
    `unsyncedMessageIds` → "There's newer mail in this conversation." and `syncMailboxId`, so the
    job asks for a sync. `threadDraftMessageIds` stays for other callers.
  - **Daily cap (20 P13):** the cap check, countdown and `autopilot_scheduled` row are one
    transaction under `pg_advisory_xact_lock(hashtext('autopilot-cap:<workspace>'))`; a rolling
    24 hours ("At most 20 in any 24 hours."). `MIN_CONFIDENCE_PCT` / `DAILY_AUTOPILOT_CAP` in
    `src/config/rules.ts`.
  - **Other languages (20 P3):** `looksNonEnglish` (src/ai/language.ts) on the draft and the
    newest part of the customer's email → "Not in English, so it waits for you."
  - **Someone new copied (20 P8):** `newPersonCopied` (pure) → "Someone new is on this
    conversation, so it waits for you." (crew aren't exempt).
  - **Why it waited (20 P7):** `src/server/autopilot-reasons.ts` (`GUARDRAIL_CODES`, `RUN_CODES`),
    `guardrailCodes` + `guardrailReasons`; `drafts.autopilot_skip` (jsonb codes) on refusals in a
    switched-on kind and stand-downs, cleared when a countdown starts. Queue card and Activity
    say why in fixed words; unknown codes are dropped.
  - **Settings → Autopilot (20 P6):** two lists from the same codes (`AUTOPILOT_WHEN_LINES` /
    `AUTOPILOT_NEVER_LINES`); a test fails when a guardrail code has no line or two.
  - **Not built (Davi's yes needed):** 20 P9 (no day or time), 20 P10 (earn only from replies sent
    one at a time; would add "batch" to `drafts.sent_via`), 48 P6 (assistant note).
- **Mail format (wave 2, `w2-mail`; Checks 43 P3 P4 P5 P6 P10, 42 P4):** every outgoing reply is built in `src/mailbox/mime.ts`; headers
  stay CR/LF-safe and threaded (In-Reply-To / References unchanged).
  - **From name (Check 43 P3):** `business_profile.from_name` (max 80, Settings → Your business
    "Name customers see on your emails"). Empty → the owner's Google name (`users.name`), else the
    business name (`pickSenderName` in `src/server/from-line-rules.ts`, read live by
    `senderNameFor` in `src/server/from-line.ts`). `formatAddress`: ASCII name → `"Name" <email>`
    (quotes and backslashes escaped), anything else → RFC 2047 word. Every rewrite of a stored
    draft goes through `draftRaw()` (drafts.ts), so an edit, a revise, a send with edits and the
    Reply-To backfill all carry the current name. The card shows "From: Mike Rossi" above To.
  - **Send-as (Check 42 P4):** `listSendAs()` (gmail.readonly, field mask: address + status
    only) → `mailboxes.send_as` (verified aliases and the primary, lowercased, max 50), read
    in the backfill job's first step (every connect and reconnect) and daily in
    `renew-gmail-watches` (`refreshAllSendAs`). Best effort: a failure keeps the stored list and
    is logged by error name only. `pickFromAddress` (from-line-rules.ts): the first send-as
    address in the customer's newest email's To, then Cc; else the connected address. Stored on
    `drafts.from_address` (null = connected address), used by every rewrite (`mimeFor`). The
    card says "From: Name · office@…" only when it differs. Practice sends stay from the
    connected address (they go to the owner).
  - **Signature (Check 43 P4):** the form says Gmail's own signature isn't added (Google adds it
    only in Gmail's web app). With `business_profile.signature` empty, the queue's first draft
    card shows "No signature. Customers won't see your phone number." + "Add a signature"
    (`/settings/profile#signature`). Read live from the profile, no table; shown on every visit
    (not once a day: no table to remember it). "Show full draft" already removes the clamp.
  - **Form-lead subject (Check 43 P5):** when the reply goes to a Reply-To that isn't the sender
    (a website form), `formReplySubject` (mime.ts) turns a robot subject (form submission, new
    entry, new lead/message/inquiry/request from, contact form, website form/inquiry, request a
    quote) into "Your request to <business>" ("Your request" with no name); other subjects keep
    "Re: …". Threading headers unchanged. Nudges on those threads go through the same code
    (a nudge after "Your request to X" reads "Re: Your request to X"). Every draft card shows
    "Subject: …" above the reply. The Reply-To backfill's re-pointed old drafts keep their
    stored subject (not changed here).
  - **HTML part (Check 43 P6):** `buildReplyMime` writes multipart/alternative: the text/plain
    part exactly as before plus a text/html part made by `textToHtml` (every character escaped,
    line breaks → `<br>`, blank lines → `<p>`, one `<div dir="auto" style="font-family:inherit">`;
    no links, images, colours or tracking). Random boundary checked against both parts; both
    base64 UTF-8. Gmail's parser (`extractBodyText`) prefers text/plain, so `sameText` checks
    are unchanged. `FakeWriter.bodyOf` reads the text/plain part (`partOf` for either) and the
    e2e fake's `parseRaw` reads multipart. Not verified in classic Outlook.
  - **Header folding (Check 43 P10):** `encodeHeader` splits non-ASCII text into encoded
    words of at most 42 UTF-8 bytes (68 characters, under RFC 2047's 75; "Subject: " + a word
    fits a 78-character line), never inside a character, folded with CRLF + space (the input is
    CR/LF-stripped first, so folding is the only line break). `replySubject` collapses a leading
    run of reply prefixes (Re, RE, Res, RES, Re[2], Re(2)) into one "Re: "; forward prefixes
    (Fwd, FW, RV, Enc) stay after it. "RE: x" is now "Re: x". The e2e Gmail fake joins adjacent
    encoded words (RFC 2047 §6.2).
  - Known gaps: `workspaceMailboxEmails` (the "self" list for Reply-To picking and
    `answeredSince`'s "only to yourself" rule) doesn't include send-as aliases.
- **Numbers and Activity (wave 2, `w2-numbers`; Check 14 P2–P11 + Check 42 P5):**
  - Learning screen: once read, the step says "Read your last 30 days of email." with no number;
    the "Your last 30 days" section (`firstLookCounts().counts.read`) is the only final count.
    While reading it keeps Check 25 P6's running "… so far" count.
  - Time saved: one rule sentence, `timeSavedRule()` in `scorecard-rules.ts` ("Our estimate: 3
    minutes for each drafted reply or follow-up that went out, from the app, from Gmail or by
    autopilot."), said once per box on Activity and once in the Monday email.
    `timeSavedPhrase(0)` = "none yet"; `timeSavedLine(0)` = "Time saved: none, as nothing went
    out." `scorecardLines(..., { rule: false })` drops the rule where the box already says it.
  - Autopilot sends are kept apart: `autopilotSentSql()` (`scorecard.ts`) = `sent_via =
'autopilot'`, or for rows from before `sent_via`, a `reply_sent` row with `autopilot: true`.
    `ScorecardNumbers.repliesSent` / `followupsSent` are the owner's own (app or Gmail);
    `autopilotSent` is separate; minutes = 3 × all three. `MonthSummary.autopilotSent`; Activity's
    "Replies you sent" = sent − follow-ups − autopilot, plus an "Autopilot sent" tile when > 0.
    The subquery spells `"drafts"."id"` on purpose: Drizzle leaves a column unqualified in a
    select list, which inside the subquery meant the activity row's own id.
  - "Quotes out" is now "Quote requests answered" (tile and counts line); the field is still
    `quotesOut`. The response sentence names its own group ("Of this week's quote requests: none
    answered yet. 1 is still waiting.").
  - Response time shown to owners is the median (`medianMinutes`, `response.typicalMinutes`);
    `avgMinutes` stays in the data. "Your typical first answer to this week's quote requests: 20
    min, the middle of 3 (last week: 1 h)."; one answered: "1 of this week's quote requests
    answered, in 2 h 10 min." Footnote: "Clock time, nights and weekends included."
  - Activity log: `DESCRIBED_ACTIONS` / `HIDDEN_ON_PURPOSE` (`send_approved`,
    `checklist_dismissed`, `quote_lost_reason`) next to `describeActivity`. `listActivityPage`
    filters on the described list in SQL before the limit (and drops a `test_payment_reset` that
    didn't clear the setup payment), pages by `(date_trunc('milliseconds', created_at), id)`
    with `?before=<iso>_<uuid>` (zod-checked in `activity-rules.ts`), 100 per page, "Show
    older" link. Heading "What happened, newest first". `listActivity` keeps its old return
    shape for callers. Guard test `tests/unit/activity-list.test.ts`: every literal `action:
"x"` (or either side of a ternary) under `src/` must be described or hidden on purpose.
  - New Activity lines: answered_by_phone, found_money_drafts_requested,
    first_drafts_ready_sent, seasonal_note_added, never_say_saved, plus nine the guard found
    (complaint_fixed, complaint_checkin_closed, owner_cleared_injection, sender_rule_removed,
    service_town_added, trial_email_sent, trial_emails_stopped, mailbox_plan_swap,
    mailboxes_fit_plan). Content-free.
  - Found money counts are the true totals (`foundMoneyCounts`, same where-clause, no limit);
    one tap still drafts at most 10 of each kind. Over the cap: "Draft the newest 10?" (one
    kind) / "Draft up to 10 of each, newest first?" (both).
  - Activity during the trial (`!canSend` and status invited / evaluating / evaluation_expired):
    one "Your three days so far" box (sorted, drafts written, drafts you changed, practice
    copies) from `trialActivityCounts` (`first-week.ts`), no time-saved figure; week and month
    boxes only once sending can be on.
  - `firstNameOf` (`src/lib/first-name.ts`): Activity, the queue and the customer page. Null for
    addresses, business words, > 4 words; "Last, First" → First; drops Mr/Mrs/Ms/Miss/Dr.
  - Labels: "Conversations sorted", "Drafts written", trial banner "sorted N conversations",
    morning email "In the last day: N conversations sorted, M replies and follow-ups sent." (the
    24 hours before the email, kept as before; the word "Yesterday" is gone).
  - Send record (Check 42 P5): "Who okayed it" = "Your sign-in (email)" / "Sent from Gmail,
    outside the app" / autopilot as before; closing line "This is the record of the tap made
    while signed in as …. Anyone who uses this sign-in can okay replies." Reconcile's note and
    Activity's `reply_sent_from_gmail` say "sent from Gmail, outside the app". Settings → Account
    shows "Signed in as … (Google)" from the session.
- **Text summaries and waiting-quote texts (plan #50 remaining parts, 2026-10-24, branch
  `m12-sms-summary`; migration `0081_sms_summary_texts`):** two more owner texts, each its own
  switch (`business_profile.sms_summary_enabled`, `sms_at_risk_enabled`), default **off**, shown
  and active only while `sms_alerts_enabled` is on. No feature flag: the Twilio env plus the
  owner's switch is the switch, as for new-lead texts. That one master switch is what a STOP
  (send-time 21610 or a delivery report), "not a mobile" (30006) and "Remove my number" turn off;
  they also clear both new switches (`ALL_TEXTS_OFF` in `sms-delivery-rules.ts`), so after START
  the owner turns each back on. Every text asks `textsOn(p)` (confirmed number, alerts on, no
  `sms_stopped_reason`). Trade-off on purpose: no summary without new-lead texts (one switch for
  STOP to flip); Davi can ask for "summary only" later (LAUNCH step 13).
  - **Morning summary by text** (`src/server/sms-summary.ts`, rules in `sms-summary-rules.ts`):
    step `texts` of the hourly `morning-digest` job. Due at/after `digest_hour` in the owner's
    zone, once a local day, **before noon** (`SUMMARY_TEXT_LAST_HOUR` 12), never in quiet hours
    (5am/6am waits for 7am), never for read-only accounts; **independent of `digest_enabled`**.
    Counts from `digestCounts` (the queue's content-free membership): "N replies ready, N
    follow-ups ready, N need you" (needs you = needs-you cards + waiting leads with no card +
    not-answered-yet), link `/queue` (or `/quotes` when only a lead with no card waits). A quiet
    morning: no text, day marked done. Otherwise the shared text slot is claimed (10-minute gap,
    only while today isn't marked), then sent; `sms_summary_last_sent_on` ('YYYY-MM-DD') is
    written **only after Twilio accepted it**; refused / not configured / STOP → slot handed back,
    nothing marked. Activity `sms_summary_sent` {replies, followups, needsYou, deliveryId};
    failures log `sms_summary_failed` (workspace id, Twilio status, error name) and don't fail
    the job.
  - **Leads at risk by text** (`sendLeadAtRiskPushes`, `leads-at-risk.ts`): same run, moment and
    episode marks as the #34 push — one `atRiskAlertedAt` mark covers push and text. Owners with
    `sms_at_risk_enabled` count even with no phone subscribed. "N quote requests have waited over
    4 hours. Open: …" (link from `notificationUrl`). Shares `LEAD_AT_RISK_PUSHES_PER_DAY` (one
    `lead_at_risk_push_sent` row per episode, `texted: true` + `deliveryId` when texted), quiet and
    business hours, the 10-minute text slot and ten texts a day. A refused text hands its slot
    back; if neither a phone nor the text took it, the marks are taken back and nothing is
    logged. When only one of the two slots is free, the alert goes by the free one and the
    episode is marked (the other channel doesn't repeat it for the same wait).
  - **Ten texts a day, shared:** `textsSentToday` counts `sms_alert_sent`, `sms_summary_sent` and
    texted `lead_at_risk_push_sent` rows from local midnight; the tenth of any kind ends with
    "That's today's last text…" (`LAST_TEXT_OF_DAY`, now in `sms-summary-rules.ts`, re-exported
    from `sms-alerts`). Emergencies keep their own caps. New `SmsErrorCode` `alerts_off`; delivery
    rows use kind `alert`. Tests: `sms-summary`, `sms-at-risk`, `sms-texts-screen`.
