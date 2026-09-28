# Squared Away — original product brief

> Written by Davi Chaves (sales, customer setup, operations). Kept verbatim-in-substance as the
> source of truth for scope. `CLAUDE.md` summarizes it; this file has the detail each milestone needs.

## 1. What Squared Away is

A small contractor connects their Gmail. Squared Away then:

- **Triages** every incoming business email into a category: quote request, customer question, scheduling, invoice or payment, complaint, supplier or vendor, or noise.
- **Drafts the reply** in the owner's own writing voice, learned from their sent mail.
- **Holds every draft in an approval queue.** The owner opens one screen on their phone and taps Send, Edit, or Discard. Approved drafts send from their own Gmail, in the right thread.
- **Chases what went quiet.** If a quote or an invoice got no reply in a few days, it drafts a nudge.
- **Sends one morning digest** — what came in overnight, what's drafted, what needs them.
- **Autopilot, opt-in and later** — the owner can eventually let specific low-risk categories send without approval. Off by default, forever, unless they turn it on.

**The core promise: nothing leaves the owner's inbox without their okay.** Trust is the entire product. If you ever have to choose between a slicker flow and a more obviously trustworthy one, choose trust.

## 2. Who uses it

Owner-operators in three trades to start: **carpentry, plumbing, and electrical.** Anywhere in the US. One owner up to a crew of about fifteen. Not technical. Reading this on a phone, standing in a driveway, between jobs, with dirty hands.

- Mobile first. Every screen has to work one-handed at 375px wide. Desktop is secondary.
- Plain words. Never "configure your workspace preferences." It's "tell it what you don't do."
- Big tap targets, minimum 44px. Assume gloves and sunlight.
- Fast. If the queue takes three seconds to load, they close it and don't come back.

The classifier and drafter should understand trade vocabulary: a panel upgrade, a service call versus a job, rough-in and finish, a punch list, a change order, permits and inspections, T&M versus fixed price, net 30, a callback. Put trade-specific examples in the prompts.

## 3. Non-goals for the MVP

Do not build: Outlook or Microsoft 365, CRM integrations, calendar booking, SMS or phone, a native mobile app, multiple languages, team roles beyond one owner per workspace, a public API, or any model fine-tuning.

Structure the mailbox code as a "connector" interface so Outlook can be added later without a rewrite — but only implement Gmail.

## 4. Stack

- **Framework**: Next.js, latest stable, App Router, TypeScript strict.
- **UI**: Tailwind CSS + shadcn/ui.
- **Database**: Postgres on Neon (ask Davi before creating the account). Drizzle ORM, migrations checked in.
- **Auth**: Auth.js (NextAuth) with Google provider, offline access for a refresh token.
- **Background jobs**: Inngest. Every job idempotent and safe to retry.
- **AI**: Anthropic TypeScript SDK. Classification/extraction: `claude-haiku-4-5-20251001`. Drafting and voice: `claude-sonnet-5`. Model IDs in one config file. Prompt caching on the per-workspace static parts (business profile, voice profile).
- **Transactional email**: Resend. **Payments**: Stripe Checkout, Customer Portal, webhooks. **Monitoring**: Sentry. **Hosting**: Vercel. **Testing**: Vitest + Playwright.

`.env.example` lists every variable with where to get it. Never commit a real secret. If blocked on a key, say exactly what to create and where to paste it, and keep working on what isn't blocked.

## 5. Gmail integration

**Scopes.** Minimum: `gmail.readonly`, `gmail.compose`, `gmail.send`, plus `openid email profile`. Write `docs/google-verification.md` explaining in plain language why each is needed — must match what the code does.

**Restricted scope reality.** Until Google OAuth verification (incl. paid third-party security assessment), max 100 manually added test users. Build as if verification is coming: privacy policy, data handling, in-app disclosures must hold up.

**Sync.**

- On connect: backfill last 30 days — metadata for everything, bodies for threads in the inbox.
- Then incremental via Gmail History API, `historyId` checkpoint per mailbox.
- Gmail push via Pub/Sub `watch` when configured, polling fallback every 5 minutes. Renew the watch before it expires (a stale watch fails silently).

**Drafts are real Gmail drafts**, threaded with `In-Reply-To`, `References`, `threadId`. Approving sends that draft. Handle the owner editing or deleting the draft in Gmail before approving — detect and reconcile.

**Failure handling.** Token refresh, revoked access, rate limits with exponential backoff + jitter. If access is revoked, stop every job for that mailbox immediately and show "Reconnect Gmail" — never fail silently. Only ever touch the connected user's own mailbox.

## 6. Commercial flow

1. **Waitlist** on the marketing site (not in this repo). Davi invites manually.
2. **Three-day evaluation.** Invited owner signs in, connects Gmail, answers a short business profile. Classifying and drafting start immediately. **Nothing can send during evaluation** — blocked in code, not just hidden.
3. **Setup.** $499 once, then a call to go through pricing rules, scheduling, do-not-promise list, tune drafts.
4. **Subscription.** Solo $99/mo (1 mailbox), Crew $199/mo (up to 3 mailboxes, autopilot rules), Company $299/mo (up to 10 mailboxes, priority support). Month to month.

Lifecycle: `invited` → `evaluating` (3 days, sending blocked) → `evaluation_expired` (read-only, upgrade prompt) → `setup_paid` (sending unblocked, setup call pending) → `active` → `past_due` / `canceled` / `paused`. Every gate server-side: sending during evaluation returns 403.

## 7. Data model (starting point)

- `users` — id, email, name, created_at
- `workspaces` — id, owner_user_id, business_name, trade (`carpentry|plumbing|electrical|other`), status, evaluation_started_at, evaluation_ends_at, setup_paid_at, setup_call_completed_at, plan, stripe_customer_id, stripe_subscription_id, created_at
- `mailboxes` — id, workspace_id, provider (`gmail`), email, encrypted_refresh_token, history_id, watch_expires_at, status (`active|reconnect_needed|paused`)
- `business_profile` — workspace_id, services, service_area, hours, lead_time, pricing_notes, payment_terms, policies, signature, do_not_promise (list), vip_senders (list)
- `voice_profile` — workspace_id, summary, greeting_style, signoff_style, avg_length, formality, phrases_used, phrases_avoided, examples (json), updated_at
- `threads` — id, mailbox_id, gmail_thread_id, subject, participants, last_message_at, category, priority, needs_owner, needs_owner_reason, awaiting_reply_since, followup_count
- `messages` — id, thread_id, gmail_message_id, from, to, direction (`in|out`), snippet, body_text, body_purged_at, sent_at
- `drafts` — id, thread_id, gmail_draft_id, body, status (`pending|sent|edited_and_sent|discarded|expired`), reason, flags (json), confidence, created_at, decided_at
- `rules` — workspace_id, category, mode (`off|draft|autopilot`), followup_days, max_followups
- `activity_log` — id, workspace_id, actor (`squared_away|owner`), action, thread_id, detail (json), created_at
- `usage` — workspace_id, period, model_tokens_in, model_tokens_out, drafts_created, emails_sent, estimated_cost_cents

Refresh tokens encrypted with AES-256-GCM, key from env. Never log a token, email body, or customer personal details.

## 8. AI pipeline

**Classification** (every new inbound). Input: sender, subject, truncated body, thread summary, business profile. Strict JSON validated with Zod, retried once on parse failure, then flagged for the owner rather than guessed: `category`, `priority` (`high|normal|low`), `needs_owner`, `needs_owner_reason`, `summary`, `extracted` (service, address, dates, dollar amounts, urgency).

`needs_owner` must be true for: complaints, refunds, disputes, anything legal, dollar amount above the owner's threshold, first-time sender with a large request, VIP sender, low model confidence. Newsletters, receipts, supplier marketing, automated notifications are `noise` — never draft a reply to noise.

**Voice learning** (on connect, then weekly). Up to 200 recent sent emails → voice profile: openings, sign-offs, typical length, formality, phrases used / never used, five short examples. Shown in Settings in plain language, editable ("you usually open with 'Hey' and sign off 'Thanks, Davi'").

**Drafting** (categories set to `draft` or `autopilot`). System prompt rules, also spot-checked in code:

- Write like the owner. Short. No corporate filler.
- **Never invent a price, a date, an availability window, or a commitment.** Ask the customer for what's missing or say the owner will confirm, and flag exactly what to check.
- Never promise anything on the do-not-promise list.
- Match the customer's register. Stay polite.
- Quote requests: ask the trade's questions (address, scope, access, system age, permits) rather than guess a number.

Output: body, one-line `reason` ("Quote request, panel upgrade. Asked for the address and current service size."), `flags`, `confidence`.

**Follow-ups** (daily). Last message outbound from owner, category warrants a chase, nothing back in `followup_days` (default 3) → short nudge in their voice. **Max two per thread, ever.**

Prompts in `src/ai/prompts/` as versioned files. Log prompt version, model, token counts, latency per call — never content. Cost per customer per month must be visible.

## 9. Screens

1. **Onboarding** — Google sign-in → plain explanation of what it will/won't do, before the OAuth prompt → connect Gmail → short business profile → "reading your recent email to learn how you write" progress → Queue with evaluation clock.
2. **Queue (home)** — customer name, category, one-line reason, expandable draft, **Send reply / Edit / Discard**. Needs-owner items without a draft at the top with a plain reason. Swipe actions on mobile. Empty: "Nothing waiting on you." During evaluation the Send button becomes "Sending is off during your three days" — explain, don't hide.
3. **Inbox** — recent threads, category chips, filters. Read-only except "Draft a reply" and "This one needs me."
4. **Activity** — plain log, newest first; honest estimated-time-saved with the assumption shown ("about 3 minutes per drafted reply"), labelled an estimate.
5. **Settings** — business profile, voice profile, per-category rules, follow-up days, VIP senders, digest time, billing, connected mailbox with Disconnect, **Delete my data**.

`/admin` gated to Davi's email: workspaces, status, plan, evaluation end, mailbox health, draft counts, estimated AI cost. **No email content or customer names.**

Buttons name what they do ("Send reply", not "Submit"); toast uses the same word ("Reply sent.").

## 10. Brand and UI

- Name **Squared Away**, tagline "Your inbox, handled."
- Two-tone: Charcoal `#1B1B1B`, Off-white `#EFEEEA`, Paper `#F7F6F3`, Stone `#D9D7D0` (borders on light), Ash `#9A9994` (muted on charcoal), Slate `#5E5D59` (muted on light), Graphite `#262625` (raised on charcoal). **No accent color.** Status via weight, position, inversion.
- Type: **Instrument Serif** italic for display, **Inter Tight** 400/600/900 for headings/UI, via `next/font`.
- Signature headline: light italic serif line over a heavy tight sans line ending in a period. Heavy lines need `word-spacing: 0.14em`.
- **Signature moment**: on send, the item flips to charcoal: _reply sent,_ / **squared away.** + one line about what's next ("I'll nudge Dana on Thursday if she goes quiet."). Once per action, never decoration.
- Logos from Davi's icon pack: `sa.` monogram (app icon/favicon), stacked wordmark (header).
- WCAG AA, visible focus, reduced motion respected, 44px targets. All tokens in one theme file.

## 11. Security, privacy, trust

- Least-privilege scopes, encrypted tokens, HTTPS only, CSRF protection on every mutation.
- Email content goes only to the Anthropic API, for the task at hand. Never used for training; privacy policy says so.
- **Message bodies purged after 30 days** (config value), metadata and summaries kept. Scheduled job + test.
- **Delete my data**: wipes workspace, revokes Google token. One button, immediate, one confirmation.
- Every send written to `activity_log`, including whether the owner edited it.
- Rate-limit API routes. Per-workspace daily AI call cap; alert Davi at 80%.
- **Autopilot guardrails in code with tests** — never autopilot: `complaint`, any invoice/payment with an amount, `needs_owner = true`, first-time sender, draft below confidence threshold. Default off for every category.
- Davi supplies `docs/terms.md` and `docs/privacy-policy.md`; wire to `/terms` and `/privacy`; flag any place the code does something they don't describe.

## 12. Billing

Stripe: one-time **Setup $499**; monthly **Solo $99**, **Crew $199**, **Company $299**. One Checkout session (subscription mode + setup fee as one-time item). Webhooks drive workspace status — never trust the client redirect. Mailbox limits per plan server-side. Past due: pause jobs, plain banner, keep data. Never delete for non-payment. Prices in config.

## 13. Business facts

Operator **Davi Chaves**, Massachusetts, US. Phone **978-201-9763**. `SUPPORT_EMAIL` and `APP_URL` from env. Copyright: `© 2026 Squared Away — Davi Chaves, Massachusetts`. No landing page in this repo.

## 14. Milestones

Each: finish, show how to verify in the browser, commit.

0. **Scaffold** — Next.js, Tailwind, shadcn/ui, Drizzle, lint/format, Vitest, Playwright, `.env.example`, `CLAUDE.md`, GitHub Actions (lint + typecheck + tests), theme file, blank page on Vercel.
1. **Auth + Gmail connect** — Google sign-in, pre-OAuth explanation screen, token encryption, mailbox record, disconnect flow.
2. **Sync** — 30-day backfill, incremental History API sync, Pub/Sub watch with polling fallback, reconnect state, tests for revoked-token path.
3. **Classification** — Zod-validated pipeline, trade-aware prompts, Inbox screen with categories and filters.
4. **Profiles** — business profile form, voice profile from sent mail, both editable in Settings.
5. **Drafts + Queue** — real Gmail drafts, queue with Send / Edit / Discard, the _squared away._ moment, activity log, reconciliation.
6. **Workspace lifecycle** — states, 3-day evaluation with server-side send block, expiry, admin page.
7. **Follow-ups** — daily scan, nudge drafts, two-per-thread cap.
8. **Digest + Activity** — morning email via Resend at owner's time, Activity screen with honest estimate.
9. **Autopilot** — per-category rules, code-enforced guardrails, tests for each.
10. **Billing** — Stripe checkout (setup + subscription), webhooks, plan limits, past-due, Customer Portal.
11. **Hardening and launch** — Playwright connect → classify → draft → approve → send, rate limits, retention purge, delete-my-data, Sentry, `docs/google-verification.md`, terms/privacy, production deploy.

## 15. Working agreement

- **Ask Davi before**: creating any external account, spending money, choosing between paid providers, deploying to production, changing pricing or the commercial flow.
- **Don't ask about routine engineering** — decide, note it in `CLAUDE.md` → Decisions.
- Tests alongside features, especially guardrails.
- Keep `docs/SETUP.md` current (new dev running locally in < 30 min).
- When blocked on Davi: say exactly what to create and where to paste it, non-engineer steps, keep going on the rest.
- End of each milestone: what's done, how to see it, what's next, what's needed from Davi.
- If part of this plan is a bad idea once in the code, say so and why.
