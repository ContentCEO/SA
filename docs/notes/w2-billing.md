# Notes from w2-billing (wave 2, group "Billing and admin")

For the integrator to fold into CLAUDE.md / docs/LAUNCH.md / docs/privacy-policy.md, then delete.

## Migrations

- `0044_plan_ends_at` (Check 17 P3): `workspaces.plan_ends_at timestamptz` (nullable). Renumber at merge.

## docs/LAUNCH.md

- Check 17 P5: after this ships, tap **Connect Stripe again** in /admin → Payments, so the webhook
  endpoint also gets `checkout.session.async_payment_succeeded` and
  `checkout.session.async_payment_failed` (bank debits and other delayed payments).

## CLAUDE.md decisions

- **Pause and Stripe (Check 17 P2):** pausing never touches Stripe. Davi's pause explanation says
  "Their Stripe plan keeps charging…" when the account has a subscription; a paused card shows
  "Still billed in Stripe"; the owner's paused banner adds "Your plan's billing hasn't changed."
  (followed by the usual "Call Davi at …", so the spec's second sentence is folded into it).
- **Plan end date (Check 17 P3):** `applySubscription` stores `plan_ends_at` from `cancel_at`, else
  the first item's `current_period_end` when `cancel_at_period_end`; cleared when undone or ended.
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
