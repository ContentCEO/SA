# Notes from `w3-emails` (wave 3, group "App emails")

For the integrator: what `CLAUDE.md`, `docs/LAUNCH.md`, `docs/SETUP.md` and the privacy
policy should say, plus Davi's questions. Legal sentences are in `docs/notes/legal-w3-emails.md`.

## Decisions to record in CLAUDE.md

- **Check 18 P2 (Email box on /admin):** `sendEmail` throws `ResendError` (name `ResendError`,
  numeric `status`); every sender's catch block logs `...emailErrorFields(err)` (the name and the
  status as a number, never the body). Refusals are tallied per UTC day in `app_settings`
  `email-refused:<YYYY-MM-DD>` as `{"403": 3}` (purged after 14 days in the daily purge).
  `/admin` → "Email" box (`src/server/email-health-rules.ts`, pure): "Not set up" / "Test
  sender…" (inverted, because it blocks every owner but Davi) / "Sending from <address>", the
  week's refusal count and "Send me a test email" (admin only, 5 an hour, to `ADMIN_EMAIL`,
  idempotency key `admin-test-<minute>`). Only fixed result codes and a 3-digit status travel in
  the URL.
- **Check 18 P5 (Reply-To):** an owner-facing email with no `replyTo` gets `SUPPORT_EMAIL`, else
  `ADMIN_EMAIL` (both env, trimmed); none when neither is set. Notices addressed to
  `ADMIN_EMAIL` itself pass `replyTo: null` (cost alert, voice gave up, payment and billing
  notices, dispute notice, admin notices, Growth and waitlist notices, the test email).
- **Check 42 P6:** Settings → Morning email says "Goes to <sign-in> (the Google account you
  sign in with)." and Your Gmail says "If Google access stops, we email <sign-in> (your
  sign-in)."; both add "That's not one of the inboxes connected here, so check it is one you
  read." when the sign-in address isn't a connected mailbox (`appEmailsGoTo`,
  `src/server/app-emails-to-rules.ts`; the address comes from the session and is never logged).
- **Check 18 P6 + Check 20 P12:** the morning email's sent line adds "(N by autopilot)" when
  autopilot sent any in the last 24 hours (activity `reply_sent` with `autopilot: true`); the
  closing line of the morning and monthly emails is "Nothing is sent without your okay, except
  the kinds of email you put on autopilot." when any `rules` row is in autopilot mode
  (`footerLine`, `digest-rules.ts`; `autopilotOnFor` in `digest.ts`). An account in its three
  days (`effectiveStatus === evaluating`) gets "You're in your three days: replies can't go to
  customers yet. Check the drafts and choose a plan to switch sending on." under the headline,
  linking `/billing`.
- **Check 18 P7 + Check 7 P10:** one email shell, `emailShell` / `emailHtml` / `brandEmail` in
  `src/lib/email-layout.ts`: `<html lang="en">`, charset, viewport, `color-scheme: light only`,
  background on an outer table with `bgcolor`, a hidden content-free preheader (the subject for
  the summaries, the first line otherwise), buttons with a 2px off-white border (a light edge
  when a mail app darkens the page), footer links as 44px blocks at 14px. The digest, the monthly
  summary and the cost alert now build their HTML through it (text parts unchanged). Brand hex
  colors live once in `src/config/brand.ts` (`BRAND`), equal to `--sa-k-*` in theme.css
  (`tests/unit/brand-colors.test.ts` keeps them equal and refuses any other hex in `src/**.ts(x)`;
  `public/offline.html` and `src/app/icon.svg` can't import and keep their copies).

## Questions for Davi

1. **Trial emails (Check 1 P2):** the built set is day 2, the last day, and one a week after the
   trial ends ("still here"), each with a Stop link. The spec also wanted one at the moment the
   trial ends ("Your three days are up"). Add that fourth email? (A new `TrialEmailKind`, no
   migration.) Built wins until then.

## Check 1 P7 (step 6): the Gmail access-lost reason

- Built on one env, `GOOGLE_APP_STATE` (`src/config/google-app.ts`: `googleAppState()`,
  `googleWarningLine()` for Check 28 P3's connect screen, `accessLostReason()`), default
  `testing` when unset or unknown. In Testing the access-lost email's footer and Settings → Your
  Gmail's "Google access" line read "While Squared Away waits for Google's approval, Google ends
  access every 7 days. Reconnecting takes a minute and nothing is lost."; `unverified` /
  `verified` keep "Google sometimes ends access on its own, for example after a password change."
  No second env (`GOOGLE_APP_TESTING`) was added. **Live at once** (today's state is Testing).
- `docs/SETUP.md` env table has the row. For **LAUNCH.md step 0c** (integrator): "Set
  `GOOGLE_APP_STATE=unverified` (Production) when you publish the app, `verified` when Google
  approves, then Redeploy. Preview stays unset (testing). Until then the access-lost email and
  Your Gmail give the 7-day reason."
- **Integration note for the Google group (step 4, Check 28 P3):** `src/config/google-app.ts`
  exists on this branch with `googleWarningLine(state, brandName)` written to the spec's words.
  The connect page is not changed here; the Google group wires it. Take this file's version (it
  also carries the access-lost reason) and drop any duplicate.

## Check 18 P4 (step 7): invite email again, waitlist catch-up

- `sendInviteEmail(email, { again: true })` skips the per-invite marker, uses key
  `invite-<hash>-<invitedAt>-again-<YYYY-MM-DD>` and marker `invite-email-again:<hash>:<date>`
  (once a day per address; skipped once they've signed in). /admin invite list: "Email the
  sign-in link again" (admin only, 30 taps an hour) → `done=invited_emailed` / `invited` /
  `invite_emailed_today`.
- `catchUpWaitlistConfirmations` (`src/server/waitlist-emails.ts`): rows with
  `confirmation_sent_at` null and not Growth-only, oldest first, one a second, **8 per tap**
  (`WAITLIST_CATCHUP_PER_TAP`, so a tap stays inside a serverless request); stops at the first
  not-configured; each success is marked by `sendWaitlistConfirmation` itself. The button "Send
  the list email to people who never got it (N)" shows in the waitlist section only when the
  Email box says the sender is real (not `@resend.dev`), so it appears by itself once the Resend
  domain is verified and `EMAIL_FROM` changes. Result "Sent 7, 2 failed." (+ "N still to go: tap
  again."); counts only in the URL. Admin only, 10 taps an hour. **LAUNCH step 6 (integrator):**
  after switching `EMAIL_FROM`, open /admin → Waitlist and tap the catch-up button until it says
  0 to go; then tap "Email the sign-in link again" on each invite that never got its email.
  `docs/SETUP.md` §7b's "people who join before the domain is verified never get one" is now
  "…get one when Davi taps the catch-up button on /admin" (edited here).

## Check 47 P3 (step 8): waitlist mail host [M]

- Migration `0076_waitlist_mail_host` (on this branch's numbering; renumber at merge): additive
  `waitlist.mail_host text` — `google` | `microsoft` | `other` | `unknown`
  (`src/server/mail-host-rules.ts`, pure: gmail/googlemail → google; outlook/hotmail/live/msn →
  microsoft; other `PUBLIC_WEBMAIL_DOMAINS` → other; else MX ending in google.com /
  googlemail.com → google, mail.protection.outlook.com → microsoft; none → unknown; evilgoogle.com
  is not Google). `lookupMailHost` (`src/server/mail-host.ts`) uses `node:dns/promises`
  `resolveMx` on the domain only, 2 s at most, any error → unknown; `joinWaitlist` stores it
  (never blocks the sign-up).
- /admin waitlist card: "Email on Microsoft (Outlook)" / "Email not on Google" / "Couldn't tell
  where their email is hosted"; "On Outlook: N" under the heading. Inviting a `microsoft` or
  `other` row opens a confirm step ("This address isn't on Gmail, so they can't connect yet.
  Invite anyway?" → "Invite anyway" / "Keep on the list"); the action refuses without the confirm
  field (`needs_confirm`, nobody invited). **Decision:** `unknown` (DNS didn't answer) shows the
  line but does not block the invite, so a custom-domain shop stays invitable when the lookup
  failed (the spec's "for those" read literally would block every custom domain during a DNS
  outage).
- Privacy sentence → `docs/notes/legal-w3-emails.md`. Rows from before the column have null and
  show nothing.

## Check 18 P8 (step 9): each waiting quote once; greeting by the hour

- `atRiskDigestLine` now gets `leadsAtRisk - leadsAtRiskOffQueue`: the "has waited more than 4
  hours" line counts only leads with a queue card; off-queue ones are said once, under Needs you.
- `greetingFor(localHour)` / `nothingWaitingSubject` (`digest-rules.ts`): before 12 "Good
  morning." / "good morning,", 12–17 afternoon, 18+ evening; the quiet subject says "today" after
  noon. CLAUDE.md's plan #34 line ("The morning summary always has the counts-only 'N quote
  requests have waited more than 4 hours.' line") should now read "…for leads with a card on the
  queue; leads with no card get only the Needs-you line linking to Quotes."

## Check 18 P9 (step 10): List-Unsubscribe on the morning and monthly emails

- **Reused the built route** instead of a new `/api/email/off`: `stopLinkFor(workspaceId,
"digest")` signs a separate purpose (`digest-emails:stop:`; trial links keep theirs and carry no
  `k`), so a trial link can never turn the morning email off and vice versa. The digest and
  monthly sends carry `List-Unsubscribe: <…/api/emails/stop?w=…&s=…&k=digest>` and
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click` (`digestStopHeaders`; none without
  AUTH_SECRET). Alerts, invites and Davi's notices carry none.
- `/api/emails/stop?k=digest`: POST (RFC 8058, or the page's button) verifies the signature in
  constant time, turns off only `business_profile.digest_enabled` (the monthly summary follows
  it), logs `digest_turned_off` {via: "unsubscribe"} once (Activity: "You turned off the morning
  email from its Unsubscribe link"), rate-limited per link (20/h); a bad signature → 403. GET
  changes nothing: it lands on `/emails/stopped?kind=digest…`, which explains and offers "Turn off
  the morning email" (a POST), then "Morning email turned off. Turn it back on in Settings."
  **Adapted from the spec:** the spec's GET page said "Morning email turned off" while changing
  nothing, which would be untrue; the page asks instead. Trial links behave as before.
- **Goes live** with the Resend domain (nothing sends before). Nothing to set.
