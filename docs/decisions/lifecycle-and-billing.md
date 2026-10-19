# Lifecycle and billing: trial, statuses, Stripe, referrals, terms assent and account deletion

Moved unchanged from `CLAUDE.md`'s "Decisions" section on 2026-10-19 (Check 49 P5), in their
original order. Rules that a test or gate depends on are also stated in `CLAUDE.md`.

- **Lifecycle (M6):** rules are pure functions in `src/server/lifecycle.ts`; DB moves in
  `src/server/workspace-lifecycle.ts`. `effectiveStatus()` treats `evaluating` past
  `evaluation_ends_at` as `evaluation_expired`, so no gate waits on a cron.
- The 3-day clock starts on the **first Gmail connect** (`saveConnectedMailbox` → `startEvaluation`,
  only from `invited`, so reconnecting never restarts it). Cron `workspace-lifecycle` (every 15 min)
  starts any missed clocks and records expiries (logged once).
- `JOBS_ALLOWED` = invited, evaluating, setup_paid, active. Everything else is **read-only**: sync,
  classify, draft (auto and owner), voice and reconcile all skip before touching Google or the model;
  edit/discard throw `ReadOnlyError`. Read-only screens show drafts but no Edit/Discard/Draft a reply.
  Data is never deleted for expiry or non-payment.
- `StatusBanner` on every signed-in screen: "Day N of 3 · X left" during evaluation; inverted
  explanation + phone/support email when expired, setup paid, past due, paused, canceled.
- Admin sets plans by hand (`setWorkspacePlan`) until Stripe (M10); dropping to a plan without
  autopilot switches every category back to draft and clears countdowns.
- **Billing (M10, 2026-10-05):** Stripe SDK, `src/server/billing.ts` + pure rules in
  `src/server/billing-rules.ts`. Checkout (subscription mode) = plan price + the one-time setup fee
  only if the setup wasn't really paid (`setupReallyPaid`; a date alone doesn't count); one live subscription per workspace; Stripe's Billing Portal for
  card/plan/cancel. Prices are found-or-created by lookup key `sa_<plan>_<cents>_month` /
  `sa_setup_<cents>` (amount in the key → config change = new price). **Only the signed webhook**
  (`/api/stripe/webhook`) changes status: paid checkout → setup_paid (active if the setup call was
  already done); past_due/unpaid → past_due; recovered → back; canceled → canceled (subscription id
  cleared, re-checkout allowed without the setup fee). Paused and trial accounts are never moved by
  Stripe. Events are idempotent via `stripe_events` (row deleted on handler error so Stripe retries).
  Events whose `livemode` doesn't match the key's mode are answered 200 and ignored
  (`eventFromOtherMode`, 2026-10-14), so test renewals can't undo "Reset test payments" before
  Connect Stripe swaps the stored secret.
  `/admin` → Payments → **Connect Stripe** sets up prices, the portal config and the webhook, storing
  its signing secret encrypted in `app_settings` (`STRIPE_WEBHOOK_SECRET` env overrides).
  `STRIPE_SECRET_KEY` (test) is on sa Production. Owner screen: `/billing` (Settings → Plan &
  billing; banner links "See plans" / "Choose a plan" / "Update payment").
- **Delete my account (2026-10-06):** Settings → Account → one confirmation.
  `src/server/account-deletion.ts`: cancel the Stripe subscription immediately (if that fails,
  **nothing** is deleted; an already-gone subscription is fine) → revoke Google for each mailbox (best
  effort) → delete the `users` row (everything cascades) → sign out → `/goodbye`. Gmail drafts stay
  in the owner's Gmail. Logs counts only. `/signin` only bounces to /queue if the account still
  exists (a deleted account's JWT would otherwise loop). **M11 (S3):** the database part is one
  transaction that also deletes the owner's `invites` row (coming back needs a new invite) and the
  `app_settings` markers `cost_alert:<ws>:%` and `email-sent:%-<ws|mailbox>-%`. Kept on purpose
  (Davi, amendment 2): waitlist rows (may hold a Growth call request; /admin's waitlist card reads
  the invite list, not only `waitlist.invited_at`, so a deleted owner's card offers "Invite … again"
  instead of a stale "Invited" — `waitlistInviteState`, matched with the sign-in gate's own
  `inviteForEmails`); also referral_credits (salted
  hash, ids SET NULL), stripe_events, rate_limits (purged in 2 days), the draft-cleanup per-mailbox
  marker (bare uuid). `tests/unit/data-lifecycle.test.ts` is the gate: a new table or a new
  non-cascade foreign key fails it until its lifecycle is decided (KEPT / SET_NULL lists there).
- **#47 referrals (built 2026-10-12; reward = offer A since 2026-10-15/16, behind
  `FEATURE_REFERRALS`, off):** `src/server/referrals.ts`, rules in `referral-rules.ts`. Migration
  0026: `workspaces.referral_code` / `referred_by_workspace_id`, `waitlist.referral_code`,
  `invites.referred_by_workspace_id`, `referral_credits` (unique `(referred_email_sha256, side)`;
  workspace FKs ON DELETE SET NULL). Migration **0044_referral_free_month** (additive; written
  as 0028, renumbered to 0032 after round 2, to 0039 after `0038_growth` at the 2026-10-17
  merge and to 0044 after wave 1's `0043_fallback_calls` at the 2026-10-18 merge, regenerated by
  drizzle-kit each time with byte-identical SQL and journal `when` values after every earlier one
  so drizzle's migrator, which applies by timestamp, still runs it on the shared DB; `when`
  1792287535388): reward columns on
  `referral_credits` (`reward`, `stripe_mode`, `skip_reason`, Stripe ids, `attached_at`,
  `invoice_final_at`, `claimed_at` lease, `plan_change_seq`, `paid_plan/price_id/price_cents`,
  `free_plan`, `starts_at/ends_at`, `kept_at/kept_price_cents`, `ended_at`, `billing_mode`,
  `admin_flag/flagged_at`; partial unique indexes: one `scheduled` and one `running` per
  workspace), `workspaces.free_plan/free_plan_until/stripe_cancel_at`, `mailboxes.paused_reason`
  (unused since the 2026-10-17 merge, kept only so the migration stays byte-identical; a test in
  `referral-schema.test.ts` fails if any code uses it).
  Path: `/?ref=<code>` → waitlist (hidden field) → `inviteFromWaitlist` → first sign-in copies it
  (used once). Settled **once ever** when the referred account is first `active` with
  `setup_paid_via = 'stripe'`: one `pending` row (`free_month_up`, tagged with the key's
  `stripe_mode`) + Activity, or one `skipped` row (off / self / same_domain / house). Salted email
  fingerprint survives deletion. `REFERRAL_REWARD = "free_month_one_plan_up"` in `pricing.ts`;
  `referralsVisible()` = flag on and a reward set (the cash credit and its constants are gone).
  - **Mechanism:** a one-time 100%-off coupon `sa_ref_<row id>` on the referrer's live
    subscription (discounts-only updates that pass back other discounts, per-attempt idempotency
    keys, a fresh `subscriptions.retrieve(..., {expand: ["discounts"]})` decides every outcome).
    Stripe keeps billing their own plan; the renewal invoice that used the coupon starts the month
    from its **plan line** (paid plan + exact price, `free_plan = planAbove`). `effectivePlan()`
    (pure, time-bounded) is what features read: inbox limits, autopilot layer 1, Settings, /admin.
    One at a time with a paid month between (Davi Q1); attaches only while the account is on, not
    while the portal schedules downgrades, never across Stripe modes. Ends on whichever comes
    first, our clock or Stripe's renewal; `done` + `autopilotPlanEffects` + `inboxLimitEffects` +
    Activity in one transaction. The webhook reads the live subscription on every event
    (`applyLiveSubscription`: status, plan, `stripe_cancel_at`, plan effects; Q2: a move down a
    plan on Stripe's page pauses extra inboxes, newest-created first) and then reconciles rewards
    without ever failing. Sweep: `runReferralRewards` (15-min job step `referral-rewards`); a
    running month always ends even with the flag off. Backstop: positive prorations for free days
    are deleted (`invoiceItems.del`).
  - **Keep / Go back** (`keepFreePlan` / `goBackToPaidPlan`, actions in `billing/actions.ts`):
    the only code that changes a subscription's price (static test
    `referral-guardrails.test.ts`). Keep: the owner confirms plan + today's config price (inline
    confirm names price, tax, delta, first charge date); Go back restores exactly
    `paid_price_id`. Claim → per-tap key `referral-plan-<id>-v<seq>` → fresh-read verify; refused
    within 1h of the end, after Stripe renewed, while set to end or with a schedule.
  - **Q3 (yes):** while a month runs, Manage billing uses `ensureNoPlanChangePortal()` (the
    default portal settings copied with plan changes and the login page off; cached per mode in
    `app_settings` `stripe_portal_no_plan_change:<mode>`, rebuilt when the default's `updated`
    moves, recreated on `resource_missing`; any failure falls back to the default page).
  - **Paused inboxes = the decisions package's plan pause** (since the 2026-10-17 merge; the
    branch's own `status = 'paused'` + `paused_reason`, `inboxLimitEffects`,
    `resumeOverPlanInboxes`, `swapPausedInbox`, `inbox_paused` and the queue's one-line count are
    gone). `fitMailboxesToPlan` (`mailbox-plan.ts`) reads the plan that counts (`effectivePlan`,
    so a running free month's plan covers more addresses), takes the caller's transaction, and
    runs inside every referral plan write (start, end, Keep / Go back, Stripe's billed plan, the
    test-reward reset) and the webhook's (`applyCheckoutCompleted` / `applyLiveSubscription`), so
    any subscription event fits the addresses, as the 15-minute `fit-mailboxes-to-plans` would.
    `swapPlanMailbox` and `mailboxLimit` use `effectivePlan` too; the paused card in Settings →
    Your Gmail adds plan #47's "Or move to Crew in Plan & billing." link (`pausedInboxCopy`);
    the swap action keeps the Gmail-connect rate limit. Activity describes `mailboxes_fit_plan` /
    `mailbox_plan_swap` (`referralActivityLine`) and a queued send stopped by `mailbox_paused`
    (never "back in your queue").
  - **UI:** Plan & billing (billed plan stays the heading + free line, "Your free month" with
    Keep / Go back, share card + status line), a bordered banner card on every screen (second card
    under "Setup's paid"; "what changes" from 3 days before the end), Settings notes (since the
    round 2 merge: Settings → Your Gmail holds the paused lines, the swap and the add-inbox note;
    Settings → Autopilot the free-month line; the list says "· N paused"), Activity
    lines (`referralActivityLine`, owner's time zone), /admin "Free months" lines + flags + plan
    stat + Payments lines (downgrade schedules, login page), `/admin/costs` "free month" tag.
    Page loads never call Stripe for this (except /admin Payments' short portal read).
  - **Reset test payments** deletes `stripe_mode = 'test'` rows (a running one stops with its
    effects) and the test portal cache — only rows whose referred account no longer stands as
    paid through Stripe (one the reset couldn't check keeps its row, so the sweep never settles
    it again on the live key); **account deletion** clears the rows' Stripe ids.
  - **Review fixes (2026-10-16):** migration **0045_referral_after_end_check** (was 0029, then
    0033, then 0040; `when` 1792287541302) `referral_credits.after_end_checked_at`: the
    Stripe follow-up after `done` (strip a lingering coupon, sweep or flag free-day charges, flag
    `second_month_given` when the next renewal used our coupon too) is retried by every sweep
    (flag on or off) until it fully goes through. A running month whose invoice is still a draft
    has our coupon taken off from 24h before the end (`STRIP_BEFORE_END_MS`; flag
    `free_invoice_lost_discount` if the draft loses its discount — unchecked live). A renewal
    that skipped our coupon while it stayed on keeps the row **scheduled** for the renewal after
    (so account-off detach and use detection still apply); a booked coupon on an old, still-live
    subscription comes off before the row waits again. `applyCheckoutCompleted` runs the plan
    effects with its plan write (Q2 pause no longer depends on webhook order). A paused inbox
    that lost Google access resumes as `reconnect_needed` (`resumedInboxStatus`). Activity's
    `send_stopped` / `inbox_paused` line never says "back in your queue". /admin Payments shows
    a positive "changes plans straight away" line or "Couldn't check…" (never silence). Plan &
    billing says what moving down pauses (`downgradePausesLine`). Flags: neutral
    `plan_changed_in_free_month`, separate `free_day_charges_removed`.
  - Answers (Davi 2026-10-16): Q4 free Company includes priority support; Q5 waiting months never
    expire; Q6 refunds don't claw back; Q7 no reminder email. Terms/privacy lines wait in
    docs/SETUP.md §6d. The local Stripe Test Clock check (§6d step 4) has **not** been run.
  - Test seams: `setReferralConfigForTests({ reward })`, `tests/support/fake-stripe.ts` (typed on
    stripe@23, idempotency like Stripe, renew / portalChange / clock).
  - **The Growth door (Davi 2026-10-16: "a Growth request can earn a referral"; built
    2026-10-17):** `requestGrowthCall` keeps the form's `ref` on the waitlist row only while
    `referralsVisible()`, never replacing a code already there (the homepage passes it to
    `GrowthChapter` → `GrowthCallForm`; the static /growth page carries none). `startGrowth`
    (started / restarted) and `linkGrowthInvite` (linked) call `creditGrowthReferralSafely`
    (never fails Davi's move or the sign-in): `creditGrowthReferral` needs an **active**
    `growth_clients` row and resolves the waitlist row's code at that moment, then the shared
    `settleOnce` (also behind `creditReferralOnActive`): one `pending` free month (offer A, same
    pending/apply sweep) or one `skipped` row (off / self / same_domain / house), once ever per
    email fingerprint, whichever door is first — an app account and a Growth client for the same
    person never pay twice. Any code on the row counts (from the app form or a Growth request).
    `settleMissedReferrals` also settles active Growth clients with a code and no referral row
    (a failed hook, or a test-mode reward Reset test payments deleted). Settled by another
    (deleted) workspace → the waitlist row's code is cleared too. Growth's files may import only
    `creditGrowthReferralSafely` from `referrals` and `isReferralCode` / `referralsVisible` from
    `referral-rules` (`growth-boundary.test.ts`, which also checks the settle reads no inbox
    tables). /admin's "Came from a referral link" shows on Growth requests too. Tests:
    `tests/unit/growth-referrals.test.ts`.
- **Sending requires a real payment (Davi, 2026-10-10):** `canSend` = status in `SENDING_ALLOWED`
  **and** `workspaces.setup_paid_via` ∈ {`stripe`, `house`}. `stripe` is set only by the signed
  webhook's paid checkout that included the setup fee; `house` only by the admin move
  `house_account`, which `applyAdminMove` refuses unless the workspace's owner is `ADMIN_EMAIL` (and
  the button only shows on Davi's own card, pinned first in /admin). The old "Mark setup paid" move
  is gone. Accounts hand-marked before this (via null) can't send, see "Sending turns on once setup
  is paid" + Choose a plan, and are charged the setup fee (`checkoutTerms` uses `setupReallyPaid`).
- **Stripe Tax (Davi, 2026-10-14: "turn on Stripe Tax"):** detect, don't configure. Davi
  activates Stripe Tax in Stripe's dashboard (origin address, registrations, default tax code);
  `stripeTaxActive()` (`src/server/billing.ts`) = `tax.settings.retrieve()` status `active`. No
  env var. `createCheckout` asks **first** (nothing is created in Stripe if it can't answer); a
  failure logs `stripe_tax_check_failed` {workspaceId, err.name, reason} and rethrows into the
  existing path (the action rethrows anything but `CheckoutNotAllowedError`) — never an untaxed checkout
  once tax might be on. Active → `automatic_tax: {enabled: true}`, `customer_update: {address:
"auto", name: "auto"}` (our customers are made without an address; note Checkout then saves
  the name typed there over the business name) and `billing_address_collection: "required"`;
  inactive → the session is exactly as before (tested by key set). Prices: new ones are
  `tax_behavior: "exclusive"` (tax on top, matching the terms' "plus any taxes");
  `ensurePrices({ fixTaxBehavior: true })` — **only from connectStripe** — sets found prices with
  no / `unspecified` tax behavior to exclusive (the one change Stripe allows) and never touches
  inclusive/exclusive ones. So Davi taps Connect Stripe again **before** Stripe's tax settings
  (LAUNCH.md 7e; it works whether or not tax is on, so no checkout runs with tax on and an
  unspecified price). A newly created portal configuration also allows `customer_update`
  `["address"]`; an existing one is left alone (docs tell Davi to tick Billing address).
  `/admin` Payments: `salesTaxStatus()` (5 s timeout, no retries, never throws; null without
  Stripe) → `SALES_TAX_LINES` in `billing-rules.ts` ("Sales tax: on (Stripe Tax is set up)." /
  "off. Set up Stripe Tax in Stripe to charge it." / "couldn't check."), plus `SALES_TAX_ON_NOTE`
  under "on": Stripe's status turns `active` once the head-office address is saved — it only
  means Stripe can calculate tax, and it charges tax only where a registration exists. So 7e's
  "worked when" is "on" **and** Stripe → Tax → Registrations listing each state. Owner copy:
  `SALES_TAX_NOTE` "Plus sales tax where it applies." under the plan cards on the homepage and
  /billing (static: true whether or not tax is on). Privacy policy: Stripe's checkout may ask
  for the billing address; we don't store it (tested; no address column); Stripe saves it and
  the typed name on its customer record, which account deletion leaves at Stripe (the "Delete my
  account" bullet says so; tested against `customer_update` in billing.ts). Subscriptions made
  before Stripe Tax was active keep running untaxed until changed in Stripe.
  **Stripe error logs:** stripe-node 23's `StripeError` never sets `name` (always "Error"); the
  class is in `type`. Log `reason: stripeErrorReason(err)` (`stripe-error-rules.ts`, fixed codes)
  next to `err.name`, and build test errors with `new Stripe.errors.<Class>(...)`, never a
  hand-set `err.name`.
- **Reset test payments (Davi, 2026-10-14):** /admin → Payments, **live key only**
  (`stripeKeyMode` in `billing-rules.ts`: `sk_live_` / `rk_live_`; `stripeMode()` in billing.ts,
  also what Connect Stripe's LIVE/TEST notice reads). Test key → the card says "Reset test
  payments shows up after you switch Stripe to live mode." and both actions refuse
  (`StripeNotLiveError`) before any Stripe call. `src/server/test-payments.ts`, rules in
  `test-payment-rules.ts`. Candidates = any Stripe id or `setup_paid_via = 'stripe'`;
  `customers.retrieve` / `subscriptions.retrieve` with the live key: `resource_missing` = test
  id, an answer (a `{deleted: true}` customer too) = live, anything else = "couldn't check" (the
  account is left whole). Reset = the 2026-10-10 precedent: clear the test ids; `setup_paid_via`
  'stripe' → null unless a live customer or subscription is left (a 'stripe' setup with no ids
  counts as test); `setup_paid_at` is **kept**, like the precedent's hand-marked accounts
  (review fix: clearing it made Resume send a paused reset account to evaluation_expired);
  house keeps house; setup_paid / active stay (can't
  send, setup fee at checkout); past_due → `restored()` (a test subscription can't be paid);
  other statuses and the plan unchanged. One transaction per account with a conditional UPDATE on
  the ids, `setup_paid_via`, status and setup-call nullness (a live checkout meanwhile is never
  overwritten; counted as couldn't check), `clearAutopilotCountdowns` (extracted from
  `setWorkspacePlan`), activity `test_payment_reset` (booleans; Activity shows "Your test payment
  was cleared — the setup fee is still due" only when the setup payment went; no "choose a
  plan", since a paused account can't). No Stripe
  call on a plain page load: **Check test payments** asks Stripe and keeps counts only in
  `app_settings` `stripe_test_payments` (`{found, unchecked, reset, at}`); the card shows "Test
  payments: N accounts still carry a test-mode payment." and, when N or M > 0, **Reset test
  payments** behind the details/confirm pattern ("Yes, reset test payments") → "Test payments
  reset for N accounts." (+ "Couldn't check M accounts. Tap again."). Afterwards: admin card
  (Setup paid: Not yet, it reads `setup_paid_via`), checkout (fee included; a real payment now
  records its own `setup_paid_at` unless one was already really paid), `resumeTarget` (unchanged:
  a paused reset account resumes to setup_paid / active, still unable to send), house move (keeps
  any date), `/billing` (`billingStatusLine`: "Sending turns on once your setup payment goes
  through." instead of "Setup's paid…" / "renews monthly"; the Stripe-page sentence only with a
  customer id), autopilot (locked: "Autopilot opens up once your setup payment goes through.";
  the owner's switches are kept). Referral settlement needs `setup_paid_via = 'stripe'`, so a
  reset account settles only after it really pays. `/admin/costs` still counts setup_paid/active
  as revenue (status-based). LAUNCH.md step 7 order (2026-10-15 review): 7a key swap, 7b Connect
  Stripe again **right away** (only `connectStripe` creates a webhook endpoint, so a live checkout
  paid before it never reaches the app and nothing can mark it paid; 7a–7c in one sitting), 7c
  Check / Reset test payments (order-independent: `eventFromOtherMode` drops test events before
  Connect, and they fail the live endpoint's signature after it). The past_due → `restored()`
  move leaves read-only without a payment (jobs and AI resume, still can't send):
  `PAST_DUE_RESET_NOTE` says so on the /admin confirm and in LAUNCH.md 7c, and step 13 asks Davi
  whether that's okay (keeping past_due read-only would be a small code change).
- **"I agree" boxes (Davi, 2026-10-15: "add those in"; branch `claude/squared-away-mvp-ddxl7s`,
  on top of PR #10):** Massachusetts' SJC enforces online terms only with clear notice and clear
  assent (Kauders v. Uber 2021); a checkbox plus a button with the terms linked was enough in Good
  v. Uber (2024).
  - `TERMS_VERSION` (`src/config/legal.ts`) = the terms' "Last updated" date as YYYY-MM-DD
    (`2026-10-15`); a unit test keeps it equal to both docs' dates. **Bump it with the docs**:
    everyone is asked again on their next screen. Migration 0027 (additive): `users.terms_accepted_at`
    / `users.terms_version` (latest acceptance only; no history). Goes with the user row on Delete
    my account (cascade). Rules in `src/server/terms-rules.ts` (pure), DB in `src/server/terms.ts`.
    **A newer version on record counts as agreed** (`hasCurrentTerms`: stored YYYY-MM-DD ≥
    TERMS_VERSION; anything not shaped like a date never counts), and `recordTermsAcceptance`
    never lowers a stored version (`collate "C" <=` in the UPDATE's WHERE): previews share the
    production DB and a Vercel rollback runs older code, so an exact match would flip owners back
    and forth between versions and show "we've updated our terms" when nothing changed.
  - **Sign-in:** `/signin` renders `TermsForm` (`src/components/app/terms-form.tsx`, client,
    `useActionState`): an unticked box (no `required`: the server is the gate) + Sign in with
    Google → `signInWithGoogleAction` (`src/app/signin/actions.ts`, public). Without
    `agree=yes` → plain error, focus moves to the box. With it → cookie `sa_terms_agreed` =
    TERMS_VERSION (httpOnly, SameSite=Lax, Secure in production, path `/api/auth`, 10 min) →
    `signIn("google")`. Auth.js's jwt callback (sign-in only) calls `takeSignInAgreement`: records
    the acceptance when the cookie names the current version, deletes it either way, never fails
    sign-in.
  - **Every signed-in screen:** `requireOwner()` / `requireAdmin()` (after the non-admin 404)
    redirect anyone without the current version to `/welcome/terms?next=<path>` ("one thing
    first, the fine print." first time; "we've updated our terms." after a bump; Agree and
    continue; then "Don't agree?" with the ways out). The page is
    `src/app/welcome/terms` (outside the (app) layout, whose nav would loop) and uses
    `requireSignedIn()` (signed in + workspace, no terms; only that page and its actions may use it,
    static test). `agreeToTermsAction` re-checks the box server-side and redirects to
    `safeNextPath(next)` (one leading `/`, then no `/` or backslash; no backslash, whitespace or
    control characters anywhere; same-origin by URL parse; never `/welcome/terms` or `/api`;
    ≤1000 chars; else `/queue`; both reads are reviewed exceptions in the C4 test). **Where they were going** comes from
    `src/proxy.ts` (Next 16's middleware): on the signed-in paths only (a test checks every
    `(app)` folder is in its matcher) it overwrites the request header `x-sa-request-path` with
    the path + query (minus `_rsc`); `requireOwner` reads it through `safeNextPath`. It checks
    and blocks nothing.
  - **API routes** that read the session (`/api/badge`, `/api/push/summary`,
    `/api/drafts/[id]/send`, `/api/gmail/callback`) answer **403** `TERMS_REQUIRED_API_MESSAGE`
    (never a redirect) right after the 401 check, before any limit, send or Google code exchange
    (C3 test). The badge leaves the icon as it is on 403; the service worker shows its generic
    line. Background jobs keep running for accounts that haven't agreed (the gate is on the
    person, not the mailbox).
  - **Leaving without agreeing (review fix, 2026-10-15):** the terms and privacy policy an owner
    already agreed to promise they can cancel, disconnect Gmail or delete their account any time,
    so `/welcome/terms` → "Don't agree?" offers **Manage billing** (Stripe's portal, only with a
    Stripe customer; `createPortal(workspace, "/welcome/terms")` returns there), **Disconnect
    Gmail** per mailbox, **Delete my account** (both with the same confirmations as Settings:
    `DeleteAccountButton` / `DisconnectButton` moved to `src/components/app/` and take the
    action as a prop) and Sign out. Their actions (`deleteAccountFromTermsAction`,
    `disconnectMailboxFromTermsAction`, `openPortalFromTermsAction` in
    `src/app/welcome/terms/actions.ts`) run the same server code as Settings' / Plan & billing's
    (same billing rate limit) but are guarded by `requireSignedIn` (requireOwner would loop
    them back), reviewed in `SIGNED_IN_ONLY` of the C1 test; they only end or remove things.
    The portal redirect is a reviewed C4 exception (Stripe's URL). Results come back as
    `/welcome/terms?done=disconnected` / `?error=delete_billing|busy|unknown`.
  - **Stripe Checkout:** `createCheckout` adds `consent_collection.terms_of_service = "required"`
    and `custom_text.terms_of_service_acceptance` ("I agree to the [Terms of Service](APP_URL/terms)
    and the [Privacy Policy](APP_URL/privacy)."). Stripe refuses that until a Terms of Service URL
    is saved in Dashboard → Settings → Business → Public details; its docs say so but don't print
    the error, so `isTermsUrlMissingError` (`stripe-error-rules.ts`) = a
    `StripeInvalidRequestError` whose `param` starts `consent_collection`, or whose message names
    the terms of service and a URL / public details (**not checked live**: no Stripe key in the
    sandbox). Then: `console.warn("stripe_terms_url_missing", { workspaceId })`, the same session
    again without the two keys, and `app_settings` `stripe_terms_box_off` (time) → /admin Payments
    shows `TERMS_BOX_OFF_LINE`; a later checkout with the box deletes it. Writing the note never
    fails a checkout. Any other Stripe error (or a refusal of the retry) goes up as before; no
    third try; no Stripe call on page load.
  - Docs: LAUNCH.md "Add your terms link in Stripe (right after step 1)" (test mode) and 7d (live
    mode), both with the admin line as the check. **Two merges:** PR #10 (`claude/launch-integration`)
    puts `/terms` and `/privacy` live (production 404s them until then); the boxes, the terms
    screen, Stripe's box and the /admin line ship only with the second merge of
    `claude/squared-away-mvp-ddxl7s` (LAUNCH.md step 1 says so). Both merged on 2026-10-16:
    PR #10 = `8cfb749`, PR #11 = `c1bf580`; the terms gate is live in production since `c1bf580`; step 13 "Decided on 2026-10-15"; privacy policy: "When you
    agree to our terms" (time + version), the short-lived sign-in cookie, and retention (until
    Delete my account). `docs/terms.md` text unchanged; both docs stay dated October 15, 2026.
  - e2e: `signInAs(context, owner)` marks the user as agreed (current version) unless
    `{ agreedToTerms: false }`; `tests/e2e/terms.spec.ts` covers the sign-in box (error + focus,
    stays on /signin; with it, Google's routed consent and the cookie), the hold on
    /welcome/terms (screens redirect, `/api/badge` 403, agree → back to the screen), the
    "updated" wording, Sign out, Disconnect Gmail + Delete my account without agreeing, and a
    foreign `next`.
- **Davi's decisions package (2026-10-16, branch `decisions-build`):** migration 0036
  `decisions` (additive; 0035 on its branch): `mailboxes.plan_paused_at`, `workspaces.trial_emails_stopped_at` /
  `trial_emails_sent` (text[]), partial unique index `drafts_one_thank_you_per_thread`. Prompt
  `purpose.v2` (re-exports v1's three tasks unchanged, adds `thankYouTask`); eval cases added
  (`tests/evals/purposes.ts` thank-you ×3, `cases.ts` i-paid-happy / i-paid-zelle).
  - **Headline:** "Built for carpenters, plumbers, and electricians" (hero, both meta
    descriptions, `opengraph-image.tsx`); `tests/unit/decisions-copy.test.ts` pins it.
  - **Trial side door stays:** the drafts are real Gmail drafts, so an owner may send one from
    Gmail during the trial; only Squared Away's own Send is off. One wording,
    `TRIAL_NO_SEND_LINE` + `TRIAL_SIDE_DOOR_LINE` (`trial-email-rules.ts`), on the homepage FAQ
    and promise, the connect explainer ("from Squared Away you can only send yourself practice
    copies"), the Day N banner (last day / expired: "to send replies from Squared Away"), the
    learning screen and /billing (trial only), the invite and first-drafts emails, the trial
    emails, `docs/terms.md` and the privacy policy (same 2026-10-16 date: no re-agree; Davi's
    call in LAUNCH.md). `sendingOffLabel(evaluating)` is now **"Send reply is off during your
    three days"** and `sendingBlockedReason` adds the Gmail line. Push stays "ready to check".
    `decisions-copy.test.ts` bans "nothing goes to a customer", "sending is off during",
    "customer: you can only send yourself practice copies", "can't be sent"….
  - **Trial emails** (`trial-emails.ts`, pure `trial-email-rules.ts`, links in
    `trial-email-links.ts`): day 1 = the existing first-drafts email (during the trial it gains the
    trial line and the stop link, and isn't emailed once stopped); `day2` from 24 h after the clock
    started; `day3` on the end's local date ("Your trial ends today at 3:00 PM") or the day before
    when the end is earlier than `digest_hour` + 2 h ("…tomorrow at 6:30 AM"); day 3 wins a tie
    and day 2 never goes after it; `after` 7–14 days after an expiry with no payment at all
    (`setup_paid_via`, `setup_paid_at` or a subscription). Window: `digest_hour` ≤ local hour < 20
    in `business_profile.time_zone` (Eastern default). Step `trial-emails` in the 15-minute
    lifecycle job, one email per account per run, marked in `trial_emails_sent` only after
    Resend took it (`array_append … where not = any`); keys `trial-<ws>-day2|day3|after`;
    no Resend → nothing sent or marked. Counts only (`trialCounts` + `queueCounts`). Every one
    carries "Stop these emails" → `/api/emails/stop?w=<ws>&s=<HMAC-SHA256(AUTH_SECRET,
"trial-emails:stop:"+ws)>` (constant-time; no secret → no link and no trial email) plus
    `List-Unsubscribe` / `-Post` headers (`OutgoingEmail.headers`). GET → 303 `/emails/stopped`
    (public, noindex; `?link=bad` changes nothing), POST (mail apps' one-click) → 200 / 400.
    Route guard `signed-link` in the C3 table. Settings → Morning email: "Trial emails" switch
    (`saveTrialEmailsAction`) only while `trialEmailsMatter` (evaluating / expired, unpaid).
  - **Plan pause** (`mailbox-plan.ts`, pure `mailbox-plan-rules.ts`): `fitMailboxesToPlan`
    (workspace row `FOR UPDATE`) keeps min(limit, connected) on — pauses the newest of those on,
    turns the oldest paused back on — after `setWorkspacePlan`, Stripe's checkout and plan
    changes (`fitMailboxesSafely`, never fails the webhook), a disconnect, and step
    `fit-mailboxes-to-plans` (15-minute backstop). Pausing clears that mailbox's autopilot
    countdowns; Activity `mailboxes_fit_plan {paused, resumed, limit}`. "Use this one instead"
    (`swapPlanMailbox`, Settings → Your Gmail; "Paused: your plan covers N Gmail address(es)."):
    one for one under the lock, or straight on when there's room; `choose` when no valid one to
    pause. **On** = `mailboxOn` / SQL `mailboxRunning()` (status active AND not plan-paused) in
    every gate that skipped a lost mailbox: sync, poll, Gmail push + watch, classify, unsorted
    sweep, voice (oldest running mailbox), drafts (every trigger → `mailbox_paused`), reconcile,
    reply-to backfill, draft cleanup, batch, follow-ups, leads at risk, not answered yet,
    new-lead texts / pushes (`freshLeads`), access-lost emails, the reconnect banner, admin's
    "jobs look stopped". `sendDraft` / `queueSend` / practice / revise / edit refuse with
    `mailbox_paused` before any Gmail call (API 403 `MAILBOX_PAUSED_LINE`, `?error=paused`);
    autopilot stands down with "This Gmail address is paused on your plan." The queue still shows
    its drafts (`QueueItem.mailboxPaused`, read-only card). A static test fails on any new
    status-only gate (`mailbox-plan.test.ts`).
  - **Reset test payments:** Davi chose "let it be usable" — already as built (past_due →
    `restored()`, jobs run, can't send without `setup_paid_via`); a test proves it end to end,
    LAUNCH.md moved it to "Decided on 2026-10-16".
  - **Lost reason "Other"** (`LOST_REASONS` + "another reason"; never the sentence's headline;
    plain text column, older code just doesn't show it).
  - **Say thanks** (Money's paid rows, replacing "Ask for a review" there; Inbox keeps its own):
    owner purpose `thank_you`, stored as `thank_you` or `thank_you_review` (the review ask inside,
    only when `reviewOfferReason` is null for that customer — the full review rules); both count in
    `recentReviewAddresses` via `REVIEW_ASK_PURPOSES`, and `thank_you_review` is inserted under
    `lockReviewAddress`. Base rule `thankYouOfferReason`: owner/auto paid mark (never not_owed),
    no injection / municipal, not junk / supplier, not a robot / receipt sender, once per thread
    (index; an expired one doesn't count; a discarded one does). A complaint or an unknown
    customer still gets a plain thank-you. Same `checkTerms` as review requests (`review: {url:
null}` flags any link on a plain one); reconcile expires it like a review note; never a job,
    autopilot, batch, earning or `followup_count`.
  - Privacy policy (same 2026-10-16 date): the trial emails in the Resend list, which trial emails
    went and whether they were stopped, and which Gmail address a plan pause stopped.
- **Referral merge (2026-10-17, branch `referral-offer-a`):** the tip (cd15c59) merged into
  plan #47 offer A with `--no-ff`. Migrations `0039_referral_free_month` (when 1792211897302)
  and `0040_referral_after_end_check` (1792211898937), regenerated on top of `0038_growth`, SQL
  byte-identical; applied on a scratch database on top of main's journal (41 rows). The two
  plan-pause implementations became one (the decisions package's `plan_paused_at`, driven by
  `effectivePlan`; see #47 "Paused inboxes"). `FEATURE_REFERRALS` stays off; no amount or plan
  logic changed. New rule: a Growth request can earn a referral (#47 "The Growth door").
- **Referral merge 2 (2026-10-18, branch `referral-offer-a`):** production `main` (bae1387, PR
  #13, wave 1 included) merged into plan #47 offer A with `--no-ff`. Migrations renumbered after
  `0043_fallback_calls`: `0044_referral_free_month` (when 1792287535388) and
  `0045_referral_after_end_check` (1792287541302), regenerated one at a time with drizzle-kit on
  top of the 0043 snapshot, SQL byte-identical; applied on a scratch database after main's
  journal. Conflicts kept both sides: the Stripe webhook keeps wave 1's paused rule (Check 17 P1:
  a paused account stays paused and Stripe's verdict goes to `paused_from`) inside the referral
  branch's `applyLiveSubscription` / `applyCheckoutCompleted` transactions, so the plan effects
  and `fitMailboxesToPlan` (driven by `effectivePlan`) still run with every plan write, paused or
  not; autopilot layer 1 reads `effectivePlan` with wave 1's `autopilotPlanNames()` wording; the
  Queue's countdown (wave 1's ISO time + clock) shows only while autopilot is open; Activity's
  `send_stopped` keeps the plan-pause line and otherwise uses wave 1's `sendStoppedWhy`; the
  status banner keeps wave 1's setup-call sentence with the free-month card under it.
  `FEATURE_REFERRALS` stays off.
- **Billing and admin (wave 2, `w2-billing`; Checks 17 P2–P11, 16 P3–P10, 1 P3, 29 P8, 5 P5):**
  - **Pause and Stripe (Check 17 P2):** pausing never touches Stripe. Davi's pause explanation says
    "Their Stripe plan keeps charging…" when the account has a subscription; a paused card shows
    "Still billed in Stripe"; the owner's paused banner adds "Your plan's billing hasn't changed."
    (followed by the usual "Call Davi at …", so the spec's second sentence is folded into it).
  - **Plan end date (Check 17 P3):** `applySubscription` stores `stripe_cancel_at` (merge C: the
    branch's `plan_ends_at` folded into the referral offer's column) from `cancel_at`, else the
    first item's `current_period_end` when `cancel_at_period_end`; cleared when undone or ended.
    /billing says "Your plan ends on Nov 16…" (owner's zone); activity `plan_cancel_scheduled`
    `{ endsOn: "YYYY-MM-DD" }`; a quiet (not inverted) banner line in the last 7 days. Past-due
    owners see the portal button as "Update card".
  - **Webhook order (Check 17 P4):** every subscription event is re-read with
    `subscriptions.retrieve` (resource_missing = canceled). An event about a subscription other than
    the stored one: ended → ignored (`stripe_event_stale`, no ids); live while the stored one is live
    → nothing changes, `app_settings` `stripe-ws:second-sub:<workspace>` + one content-free
    `second_subscription` activity row, /admin card "Two live Stripe plans: cancel one in Stripe".
    When the stored plan ends while a second is live, the second one is adopted. A second paid
    checkout keeps the stored subscription and plan. `createCheckout` expires the workspace's
    previous open session (`stripe-ws:open-checkout:<workspace>`), creates the customer with
    `idempotencyKey: customer-<workspace>` and stores it only while still null. Live plans or paid
    checkouts with no account here are counted in `app_settings` `stripe_orphans` (/admin Payments:
    "A Stripe plan has no account here. Check Stripe." + "I checked Stripe" to clear). Delete my
    account cancels every live subscription of the customer (`liveSubscriptionIds`), still "if any
    cancel fails, nothing is deleted", and deletes the `stripe-ws:%:<workspace>` keys.
  - **Checkouts that didn't simply pay (Check 17 P5):** `payment_status` "unpaid" → ids stored,
    nothing that turns sending on, activity `payment_pending`; `async_payment_succeeded` → the normal
    paid path; `async_payment_failed` → `payment_failed_bank` and an unpaid stored subscription is
    let go so the owner can choose a plan again; "no_payment_required" → `checkout_needs_review`
    (never sets setupPaidVia), /admin card line, /billing "We've got your sign-up…". The newest of
    those actions and `payment_received` decides the /billing line (`checkoutNotice`).
  - **Billing notices (Check 1 P3):** `notifyBillingChange` emails Davi (content-free, plan name +
    kind, once per Stripe event via `billing-notice:<event id>`, Resend key `billing-<event id>`)
    for past due / recovered / canceled moves the webhook makes; never paused or house accounts.
    The owner gets one "You're set up" email after a paid checkout that included setup
    (`setup-confirmation:<session id>`), plan name only.
  - **Plan changes (Check 17 P6):** `applyPlanChange(workspaceId, from, to, by)` in
    workspace-lifecycle.ts holds the side effects (rules → draft and countdowns cleared when the new
    plan lacks autopilot; `plan_changed { by, from, to }`). Called by `setWorkspacePlan` ("admin") and
    by the webhook ("stripe") on a subscription's plan change and on a paid checkout's plan. Item 3
    (over-limit lines, no automatic pausing) was **not built**: Davi's 2026-10-16 decision already
    pauses the extra Gmail addresses on a lower plan (`fitMailboxesToPlan`, called from both paths),
    so an account is never left over its limit.
  - **Plan picker (Check 17 P7):** a card with a Stripe subscription shows "Plan is set by their
    Stripe subscription…" instead of the picker; `setWorkspacePlan` refuses
    (`PlanSetByStripeError`, conditional update on `stripe_subscription_id is null`) and the action
    redirects `?error=plan_stripe`. The Plan stat shows the plan's name.
  - **Refunds and disputes (Check 17 P8):** migration `0045_stripe_money_events` (id + kind primary
    key, `workspace_id` SET NULL, amount, includes_setup, evidence_due_by, outcome). Webhook events
    `charge.refunded` (refunds read with `refunds.list`; includes_setup = the charge's invoice has
    the setup lookup key's price, via `invoicePayments.list` + `invoices.listLineItems`, best
    effort), `charge.dispute.created` / `.closed`. Nothing changes status or setupPaidVia. /admin
    card lines ("Refunded $499 (setup) on Oct 20", "Card dispute open: answer by Oct 30" inverted
    until closed), Payments counts open disputes, owner activity `refund_recorded` ("Refunded $499
    to your card"), Davi emailed once per dispute (`dispute-<id>`; business name, amount, date,
    Stripe dashboard link).
  - After it ships, Davi taps **Connect Stripe again** once (docs/LAUNCH.md step 11) so the
    endpoint gets the delayed-payment, refund and dispute events. Refund and dispute rows outlive
    a deleted account (privacy policy, "How long we keep it").
  - **Waiting on Stripe (Check 17 P9):** `PaymentWaiting` (replaces the unused `RefreshUntil`)
    refreshes 10 × 3s (3 × 300ms in e2e mode), then says "Stripe has your payment, but our side
    hasn't caught up yet…" with the phone link and calls `reportStripeWaitingAction` once
    (requireOwner, `hitLimit("billing")`, only while checkout is still allowed). That writes
    `app_settings` `stripe-ws:waiting:<workspace>` (value = the `cs_…` session id from the success
    URL when it looks like one, else empty); `applyCheckoutCompleted` clears it. /admin Payments
    "An owner paid but no Stripe notice arrived (N)…" and the card "Paid, waiting on Stripe".
    success_url now ends `&session_id={CHECKOUT_SESSION_ID}` (never trusted for status).
  - **/billing without a Stripe plan (Check 17 P11):** `billingStatusLine` says "Your own test
    account. Nothing is billed." for the house account and "There's no Stripe plan attached to this
    account. Call Davi to sort it out." for a Stripe-paid setup with no subscription id
    (`setUpWithoutStripePlan`); /billing then hides Choose a plan and What happens next (display
    only — `checkoutTerms` unchanged). Without Stripe configured, /billing lists the setup fee and
    the three plans (prices, inboxes) without buttons above "Online payment isn't switched on yet".
  - **/admin layout (Check 16 P3):** a "Needs you" box right under the headline (`needsYou` in
    admin-rules.ts: Growth calls from the last 7 days — no "called" mark exists yet —, new app
    sign-ups to invite, stuck inboxes from the P1 counts, payments failed, trials ending within 24
    hours; counts only, 44px links). The waitlist section now sits above Accounts; Davi's own card is
    a folded `<details>` line "Your test account: … · status"; every card has `id="acct-<id>"`.
  - **Find and paging (Check 16 P5):** `adminOverview(now, { q, page })` (ilike on business name or
    owner email, `%`/`_`/`\` literal, 50 per page, Davi's card pinned on page 1 only); GET find form
    (`?q=`), "Show older/newer accounts" (`?page=`), "Showing 51 to 100 of 134."; invites page with
    `?ipage=`. q is never logged.
  - **Card notices (Check 16 P6):** moves and plan saves redirect to
    `/admin?done=<move>&w=<uuid>#acct-<uuid>` (errors likewise); `cardNotice` (admin-rules.ts)
    validates `w` and shows the notice inside that card with the business name or owner email
    ("Paused Ruiz Street Plumbing."). Only the uuid is in the URL. Davi's folded card opens when the
    notice is for it. A card not on the loaded page gets the old top-of-page notice instead.
  - **Take back an invite (Check 16 P7):** `removeInvite(email)` deletes an invite only while it was
    never accepted and no user has that email (lower-case), and sets the waitlist entry's
    `invited_at` back to null. "Take back this invite" (one confirmation) on "Not yet" rows. The
    manual button is now "Invite and email them". Nothing is logged.
  - **Support page (Check 16 P8):** `/admin/accounts/[id]` (no loading.tsx; requireAdmin first;
    non-uuid or unknown id → 404). `supportView` returns the account's AdminRow, the owner's Gmail
    lines per inbox ("Inbox 1", never the address) from `mailboxHealth`, and the last 50
    activity rows with only `action`, `actor`, `created_at` and the detail keys move/from/to/plan/
    kind/autopilot/stripeStatus/code/by (picked in SQL with `jsonb_build_object`). Sentences come
    from `supportSentence` (no first-name lookup). The card's name links there. `statusLabel` moved
    to admin-rules.ts.
  - **Invite list (Check 16 P9):** `listInvites` returns `gmailConnected` (a workspace owned by that
    email has any mailbox row). The test-user reminder and "I added them" hide for connected owners
    ("Google test user: confirmed (Gmail connected)") and for Davi's own address; the Audience link
    is a 44px target; each row says "Invited Oct 12".
  - **AI costs (Check 16 P10 + Check 29 P8):** `planRevenueCents` is 0 for the house account (so no
    cost alert for it); `costRows` uses `effectiveStatus` and the page shows /admin's status labels
    and "Your test account". New `src/config/fees.ts` (`STRIPE_FEES`: 2.9% + 30¢ card, 0.7% Billing,
    `taxPercent: null` until Davi confirms Stripe Tax's rate; checked 2026-10-18 against
    stripe.com/pricing; not pricing). `costLine` adds `feesCents` and `marginAfterFeesCents`
    ($99 → 386¢, $199 → 746¢, $299 → 1106¢); `marginCents` and the alert rule are unchanged. Rows
    read "plan $199 · after Stripe $191.54 · AI $8.40 · keeps $183.14".
  - **Growth card for an app owner (Check 5 P5):** a Growth-only waitlist row now says "Also uses
    the app." (inviteState has_account) or "Invited to the app, not signed in yet." (invited),
    from `growthCopy.admin.growthOnlyLine(inviteState)`; nothing beyond account/invite existence by
    email is read.
