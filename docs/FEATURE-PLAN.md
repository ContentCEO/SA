# Squared Away — feature plan (beyond the brief)

Davi picked these on 2026-10-09 from a list of 50 ideas. Numbers match that list. This file is the
spec. `docs/BRIEF.md` still wins on anything it already covers. `CLAUDE.md` rules still apply to
every feature (two-tone UI, 44px targets, plain words, no content in logs, every gate enforced
server-side and tested).

## How to build from this file

1. Never build ahead of the milestone a feature depends on. Every feature below is filed under the
   milestone it rides on. Build that milestone's brief scope first, then that milestone's features
   here, in the order listed.
2. One milestone per session. At the end, tick the boxes here and in `CLAUDE.md`, write down
   decisions in `CLAUDE.md` → Decisions, and report: what's done, how to see it, what's next, what's
   needed from Davi.
3. Every feature ships with tests. Anything that touches sending, approval or a gate has a guardrail
   test that fails if the rule is broken.
4. Items marked ASK DAVI need an answer or an external account before the code is merged. Build
   behind a flag and keep going on the rest.
5. New env vars go in `.env.example` with where to get them. New config values go in `src/config/`.
6. Prompts live in `src/ai/prompts/` as versioned files. Bump the version when you change one.

## Rules every feature must keep

- Nothing leaves the inbox without the owner's okay. No feature here adds a send path that skips
  approval (autopilot from the brief is the only exception, with its own guardrails).
- Sending is blocked during evaluation and when read-only (`evaluation_expired`, `past_due`,
  `canceled`, `paused`). Every new send path goes through the one server-side send gate. The only
  exception is #40 below, written out exactly.
- Never invent a price, date, availability window or commitment in a draft.
- Max two follow-up nudges per thread, ever. #26 below does not change this. See its rule.
- No red/green/blue. Status = weight, position, charcoal/off-white inversion.

## Milestone 2 — Sync

- [x] **#44 Mailbox health page.** _(Done 2026-10-09.)_ Settings → "Your Gmail": last sync time ("2 minutes ago"), push
      watch status, token status, all in plain words. One "Reconnect Gmail" button when anything is
      wrong. Data comes from `mailboxes` (add `last_synced_at`, `last_sync_error_code` — a code,
      never message content). Tests: each state renders the right plain sentence; reconnect button
      shown only when needed.

## Milestone 3 — Classification

- [x] **#48 More trades.** _(Done 2026-10-09.)_ Add `hvac`, `roofing`, `painting`, `landscaping` to the `trade` enum
      (migration). Each trade gets its own example file in `src/ai/prompts/trades/<trade>.ts` with
      vocabulary and the questions a quote request should ask (carpentry/plumbing/electrical get the
      same treatment). Invite script accepts the new trades. Tests: every enum value has a prompt
      file.
- [x] **#17 Permits and inspections.** _(Done 2026-10-09.)_ New `extracted.permit` block from the classifier: issuing
      body, permit number, inspection date/time, pass/fail, list of corrections. Mail from town/city
      building departments is never `noise`. Shown as a small card on the thread. No reply drafted to
      a municipality unless the owner taps "Draft a reply". Tests: fixture emails (pass, fail with
      corrections, scheduling notice).
- [x] **#27 (data part) Invoice facts.** _(Done 2026-10-09.)_ Classifier extracts invoice number, amount, due date and
      paid/unpaid signals into `extracted.invoice`. The view is built in M7.
- [x] **#42 Prompt-injection guard.** _(Done 2026-10-09.)_ Before classification, a cheap check (rules + Haiku) flags
      emails that try to instruct the AI ("ignore previous instructions", hidden text, base64 blocks,
      "send me the owner's…"). Flagged → `needs_owner = true`, reason "This email tries to give
      instructions to the assistant", never drafted automatically, never eligible for autopilot.
      Email text always goes into prompts inside clearly delimited untrusted blocks. Tests: a set of
      injection fixtures all end up `needs_owner` with no draft.
- [ ] **#46 Prompt evaluation set.** _(Davi 2026-10-09: run before each release / on demand, not nightly — keeps the cost to a few dollars a month.)_ `tests/evals/` with 60+ invented trade emails (no real customer
      data) and the expected category, priority, `needs_owner` and must-not-contain rules for
      drafts. `pnpm eval` runs them against the live models and prints a score table plus token
      cost. Runs on demand and nightly in CI only when `ANTHROPIC_API_KEY` is set as a CI secret,
      never on every PR. Fails if accuracy drops below the last committed baseline
      (`tests/evals/baseline.json`). Extend it in every later milestone (drafting, follow-ups,
      injection).

## Milestone 4 — Profiles

- [ ] **#39 Onboarding checklist.** A plain checklist on the queue until done: "Connect Gmail" →
      "Tell us what you do" → "Check your first 3 drafts". Each step ticks itself from real data.
      Dismissable after all three. Tests: checklist state from DB.
- [ ] **#23 "Never say this" list.** Extends `voice_profile.phrases_avoided` and
      `business_profile.do_not_promise`. Owner adds phrases in Settings, or (after M5) by
      long-pressing selected text in the draft editor → "Never say this". Drafts are checked in code
      after generation (see #43); a match regenerates once, then flags. Tests: a banned phrase never
      reaches the queue unflagged.
- [ ] **#25 Seasonal notes.** Short notes with an end date ("Booked through November", "On vacation
      Aug 1–10, back Aug 11"). Added to the cached business profile while active, removed
      automatically after the end date. Max 5 active. Drafts may mention them but still never invent
      dates beyond what the note says. Tests: expired notes never reach the prompt.

## Milestone 5 — Drafts + Queue

- [ ] **#43 Check drafts in code before they're shown.** After the drafter returns, a deterministic
      check finds any dollar amount, date, time, weekday, "guarantee/warranty/promise" word, or
      do-not-promise / never-say phrase that is not present in the source thread or business
      profile. Any hit → draft flagged with the exact text to check, confidence capped. Hits that
      invent a price or date → regenerate once, then flag. This is the core trust feature: test it
      hard (unit tests per rule + eval fixtures).
- [ ] **#2 Gaps to fill in.** When the drafter doesn't know a fact, it emits a typed placeholder
      (`{{price}}`, `{{date}}`, `{{time}}`, `{{custom:label}}`) instead of vague wording. Queue shows
      each gap as a highlighted inline chip; tapping opens a big input. Send reply is disabled until
      every gap is filled — enforced server-side too (a body containing `{{` is rejected with a
      plain message). Tests: server rejects unfilled gaps.
- [ ] **#1 "Why this draft" panel.** Tap "Why this?" under a draft: the one-line reason, which
      business-profile facts it used, which voice traits it used, and which flags fired. The drafter
      returns `used_facts: string[]` (keys, not free text). No hidden reasoning shown, just facts.
- [ ] **#8 Confidence in words.** Map confidence + flags to three labels, shown by weight not
      colour: Ready / Check the details / Check everything. Flags always force at least "Check the
      details". Thresholds in `src/config/drafting.ts`.
- [ ] **#3 Quick-tweak chips.** "Shorter", "Warmer", "More formal", "Ask for photos", "Add my
      availability" (uses seasonal notes/hours only). Each regenerates with the same guardrails and
      #43 check, updates the Gmail draft, and logs `draft_revised` (content-free). Rate-limited per
      draft (5). Tests: a tweak can't remove a flag the check would raise.
- [ ] **#4 Voice-to-edit.** _(Davi 2026-10-09: go ahead. Browsers send speech to Google/Apple for transcription, so "audio never leaves the device" can't be promised — show a plain note by the button instead.)_ Hold-to-talk button in the editor. Use the browser's Web Speech API (no
      new paid provider); hide the button where unsupported. The transcript is an instruction ("tell
      her Thursday works, 450") → drafter revises → owner sees the result before sending. Facts the
      owner dictated count as source facts for #43. Audio never leaves the device.
- [ ] **#5 Batch approve.** "Review all ready" mode for drafts labelled Ready in categories the owner
      picks (never complaints, never invoices with amounts, never `needs_owner`, never flagged).
      Shows a full list with recipient + first line of each; one "Send N replies" button after a
      confirmation. Every send still goes through the one send gate and is logged individually.
      Tests: ineligible drafts can't be batch-sent even if the client sends their IDs.
- [ ] **#7 Undo send.** Approve → status `sending` with `send_after = now + 20s` (config
      `UNDO_WINDOW_SECONDS`, 10–30). The "squared away." moment shows with an Undo button and
      countdown. An idempotent Inngest job sends at `send_after` and re-runs the send gate at that
      moment (status can change in 20s). Undo before then → back to pending. Tests: undo works; gate
      re-checked at send time; double-send impossible.
- [ ] **#6 Snooze.** "Remind me" → Tonight (6pm local) / Tomorrow morning / After this job (3h).
      Snoozed items leave the queue and come back on top. Emergencies (priority high +
      `needs_owner`) can't be snoozed past tonight.
- [ ] **#9 Swipe + haptics + left-handed.** Swipe right = open to send (never sends straight from a
      swipe), swipe left = discard with undo toast. `navigator.vibrate` where available. Setting "I
      hold my phone in my left hand" mirrors swipe directions and moves primary buttons.
      Reduced-motion respected. Playwright mobile tests for both hands.
- [ ] **#41 Proof-of-okay receipt.** Every sent item has "See record": who approved it, when, from
      which device type, edited or not, tweaks used, undo window, Gmail message ID. Read from
      `activity_log`. This is the answer to "did the AI send that on its own?".
- [ ] **#21 Learn from edits.** When a draft is sent edited, store a content-free diff summary
      (length change, opening/sign-off changed, sentences removed, tone shift — computed by Haiku,
      stored as structured fields, not text). Weekly job proposes voice-profile updates in plain
      words ("You always cut the first sentence. Start shorter?") that the owner accepts or ignores
      in Settings. Nothing changes the voice profile without the owner's yes.
- [ ] **#36 Install as an app (PWA).** Web manifest (already started), service worker, install
      prompt with plain instructions for iPhone ("Share → Add to Home Screen"). Web Push with VAPID
      keys (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` in env). Push payloads never contain customer
      names or email text: "1 new quote request needs you."
- [ ] **#10 Offline approvals.** _(Davi 2026-10-09: opt-in setting only; off by default, since it stores email text on the phone.)_ With no signal, the queue (cached by the service worker) still
      opens. Tapping Send reply offline stores an intent locally and shows "Will send when you're
      back online." On reconnect the intent is posted; the server treats it like a fresh approval
      (full gate, draft must still be pending and unchanged in Gmail — otherwise tell the owner and
      don't send). Intents older than 12h are dropped with a notice. Tests: stale/changed draft is
      never sent from an old intent.
- [ ] **#37 Sunlight mode.** Header toggle: bigger type, heavier weights, pure charcoal on pure
      off-white, thicker borders. Tokens in `src/styles/theme.css` under `[data-contrast="high"]`.
      Remembered per device.

## Milestone 6 — Workspace lifecycle

- [ ] **#40 Practice sends during evaluation.** Exact rule: during `evaluating`, Send reply on any
      draft opens "Send it to yourself instead?" — it sends a copy only to the owner's own connected
      mailbox address, subject prefixed "[Practice]", never to the customer and never in the
      customer's thread. Server-side: in `evaluating`, a send is allowed only if the full recipient
      list (to/cc/bcc) equals exactly the owner's own address; anything else stays 403. Max 10
      practice sends per workspace. Guardrail tests: customer recipient → 403; cc to a customer →
      403; 11th practice send → 403.
- [ ] **#45 Admin cost dashboard.** `/admin/costs`: per workspace, this month's AI cost (from
      `usage`), plan revenue, margin, calls vs daily cap. Sort by worst margin. Alert Davi (email via
      Resend) when a workspace's AI cost passes 40% of its plan price. No email content or customer
      names, ever.

## Milestone 7 — Follow-ups

- [ ] **#26 Ask why a quote went quiet.** ASK DAVI before merging — it touches the two-nudge rule.
      Default design that keeps the rule: this is not a nudge and is never automatic. After a thread
      has used both nudges and gone 7 more days quiet, the thread shows an offer: "Want to ask if
      they went another way?" Only an owner tap creates the draft; it goes through the normal queue.
      Once per thread, ever. Logged as `closing_question`, separate from `followup_count`. Tests:
      never created by a job; never twice.
- [ ] **#27 Invoice ageing view.** "Money owed" screen from `extracted.invoice`: customer, amount,
      days past due, nudges used. Sorted by oldest. Paid signals ("sent payment", Stripe/QuickBooks
      receipts) mark it paid with an undo. No accounting integration.
- [ ] **#28 Deposit reminder.** When a reply accepts a quote ("let's do it", "go ahead"), draft the
      owner's deposit instructions from `business_profile.payment_terms`. If payment terms are empty,
      flag instead of inventing. Normal approval.
- [ ] **#29 Review request.** When a thread signals the job is finished ("looks great", final
      invoice paid), offer a short review-request draft with the owner's review link
      (`business_profile.review_url`, new field). One per customer per 12 months. Never to complaint
      threads. Normal approval.
- [ ] **#30 Win/loss.** Each quote thread gets `outcome`: won / lost / no answer (auto-guessed, owner
      can change with one tap). Monthly close rate on Activity.
- [ ] **#15 Price memory (owner-only).** From the owner's own sent quotes, extract service + price +
      date into `price_history`. In the queue, a quote request shows "Last 3 similar: $1,800 (Mar),
      $2,100 (Jun)…" to the owner only. Never inserted into a draft automatically; the owner can tap
      a figure to fill a `{{price}}` gap (#2). Tests: drafter prompt never receives price history.

## Milestone 8 — Digest + Activity

- [ ] **#31 "Needs you" header** at the top of the digest: max 3 items, each a deep link into the
      queue. If nothing needs them, say so in one line.
- [ ] **#32 Weekly scorecard.** Monday digest section + Activity card: replies sent, average
      response time, quotes out, follow-ups sent, estimated time saved with the assumption shown and
      labelled "estimate".
- [ ] **#33 Response-time stat.** Average time from inbound quote request to owner reply, this week
      vs last. Plain sentence, no charts with colour.
- [ ] **#34 Leads at risk.** A quote request with no reply after 4 hours (config, inside business
      hours only) → push notification (#36) or, without push, a line in the next digest. Max 3
      pushes a day.
- [ ] **#35 Monthly summary.** First-of-month email: busiest services, where leads came from, repeat
      customers count, win rate. Counts and categories only.
- [ ] **#38 Badge count.** Home-screen badge with the number of items waiting (Badging API, where
      supported). True lock-screen widgets aren't possible for a web app; note that in Decisions.

## Milestone 10 — Billing

- [ ] **#47 Referral credit.** ASK DAVI: the credit amount and who gets it. Do not pick a number.
      Each workspace gets a referral link; when the referred workspace becomes `active`, both get a
      credit applied as a Stripe customer balance credit. Amount lives in `src/config/pricing.ts`.
      Self-referral and same-domain referrals blocked. Tests: credit only on `active`, once.

## After launch (Milestone 11+) — were MVP non-goals

- [ ] **#49 Outlook / Microsoft 365.** ASK DAVI: needs an Azure app registration and Microsoft
      publisher verification. Implement `src/mailbox/outlook/` against the existing connector
      interface using Microsoft Graph (delta queries for sync, `createReply` drafts, subscriptions
      for push). Same encryption, same revoke-and-delete rules. Connector contract tests run against
      both.
- [ ] **#50 Text me a summary.** _(Partly done 2026-10-09: opt-in, code-verified number, content-free new-lead alerts, quiet hours, caps — off until Twilio env is set. Still to do: digest summary by text, leads-at-risk by text.)_ ASK DAVI: needs a Twilio account, A2P 10DLC registration, and has a
      per-message cost. Opt-in per owner, verified phone number, digest summary + leads-at-risk
      alerts by SMS. Content-free like push ("2 quote requests need you — open Squared Away").
      STOP/HELP handled. Owner can't reply to customers by SMS.
