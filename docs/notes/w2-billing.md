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

## docs/LAUNCH.md (Check 17 P8)

- After this ships, tap **Connect Stripe again** so the endpoint gets `charge.refunded`,
  `charge.dispute.created` and `charge.dispute.closed` (same tap as the Check 17 P5 events).
- Replace 7f's "a refund doesn't move the account back" with: "A refund or card dispute shows on
  the account's /admin card (and disputes in Payments, plus an email). Nothing moves the account
  on its own: decide in Stripe and /admin what a refund means."

## docs/privacy-policy.md (Check 17 P8)

- Under "How long we keep it": "If you get a refund or open a card dispute, we keep its amount and
  dates (no card details) after you delete your account, like Stripe's own payment records."
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
