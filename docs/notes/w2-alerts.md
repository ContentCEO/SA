# Notes from branch `w2-alerts` (wave 2: Phone alerts and the app)

For the integrator to fold into `CLAUDE.md`, `docs/LAUNCH.md` and `docs/privacy-policy.md`.

## Migrations (renumber at merge)

- `0067_push_failures` (Check 19 P5): `push_subscriptions.fail_count` (int, default 0),
  `push_subscriptions.first_failed_at` (timestamptz).
- `0068_sms_deliveries` (Check 19 P6): new table `sms_deliveries` (id, workspace_id cascade,
  message_sid unique, kind 'code' | 'alert', status, error_code, created_at, updated_at; no body,
  no number) and `business_profile.sms_stopped_reason`.
- `0069_sms_code_tries` (Check 19 P9): `business_profile.sms_code_tries` (int, default 0).

All additive. No prompt files changed.

## CLAUDE.md (new decisions)

- **Phone alerts and the app (wave 2, 2026-10-18):**
  - **Alerts after drafting (C19 P1):** classify-mailbox raises only emergencies right away
    (`emergencyAlertsForMailbox`); the ordinary new-lead text / buzz is draft-mailbox's last step
    `lead-alerts` (`alertsForMailbox`), so the queue it opens already shows the reply. The
    15-minute backstop is unchanged. `/api/push/summary` names fresh quote requests that have no
    queue card ("1 new quote request", `newQuotesWithoutCard`, from the push cursor minus 24h,
    at-risk leads not counted twice) and opens `/quotes` when no other card is linked; the text
    links `/quotes` in the same case (`quotesWithoutCard`). `freshLeads` now also returns
    `threadId` and `lastMessageAt`.
  - **Push failures (C19 P2, P5):** `sendPushAlerts` works like the at-risk pushes: try/catch per
    owner and per phone (error name only); no phone took it → slot and cursor handed back
    (`releasePushSlot(…, previousCursor)`), no Activity row. Every push sender calls
    `recordPushResult`: gone → row deleted; sent → `fail_count` reset; failed (403 included) →
    counted, and a phone failing for 7 days (`PUSH_FAILING_FOR_MS`) is deleted. Settings'
    `PushToggle` re-saves this phone's subscription on every visit (refused → unsubscribed,
    "off"). `POST /api/push/subscription` (session, terms, same origin, `poll` limit) swaps a
    renewed address; `sw.js` posts it on `pushsubscriptionchange` (re-subscribing with the old
    options when the browser gave none).
  - **Service worker (C19 P3, C46 P3, C46 P5):** the summary lookup gives up after 4 seconds
    (`AbortSignal.timeout`, else an AbortController, plus a race that covers the body), so every
    push shows a notification (Safari drops silent ones). Badge = `/app-icon/badge-96` (the "sa."
    mark alone, light, transparent, inside the middle 80%). `refresh-offline` message re-saves
    `/offline.html` (`cache: "reload"`); the page posts it at most once a day per phone
    (`refreshOfflinePageDaily`, localStorage `sa-offline-refreshed-on`). **Editing
    public/offline.html is enough; installed phones pick it up within a day.**
  - **Code texts (C19 P4, P9):** `normalizeUsPhone` refuses toll-free (800/833/844/855/866/877/888)
    and N11 area codes. A refused or unconfigured code text clears the code, its expiry and the
    number and throws `SmsError("send_failed")` ("We couldn't text that number. Check it's a mobile
    number and try again."; log `sms_code_failed` with Twilio's status only). `textsStep()` decides
    the Text alerts screen: the code box needs a stored code. The fifth wrong guess throws the code
    away ("That code didn't match. Send a new one."); check-and-use is one conditional update.
  - **Delivery reports (C19 P6):** `sendSms` sends `StatusCallback = appUrl("/api/twilio/status")`
    and returns `{ status: "sent", sid }` (the `SmsSender` type changed). `sms_deliveries` keeps
    each report (no body, no number), purged after 30 days in the daily purge.
    `POST /api/twilio/status` checks `X-Twilio-Signature` (HMAC-SHA1 of our callback URL + sorted
    params with `TWILIO_AUTH_TOKEN`, constant time; 403 otherwise, and always 403 without the
    token). A late, earlier status never overwrites a later one. 21610 (STOP) / 30006 (not a
    mobile) switch texts off with `sms_stopped_reason` 'opted_out' / 'not_mobile' and one Activity
    line ("Turned off text alerts because you replied STOP"); cleared when the owner turns texts
    on or starts a new number. Text alerts shows "Last text delivered at 9:42am." / "Your last
    text didn't arrive. Carriers haven't approved our texting number yet." (30034) / the STOP and
    not-mobile lines. Activity's `sms_alert_sent` line reads "Texted you…" only once Twilio says
    delivered ("Sent a text to your phone…" before, "Tried to text you…, but it didn't arrive" on
    failure); the row carries our delivery row id (`deliveryId`), never Twilio's id.
  - **Caps and quiet hours (C19 P7, P8):** the ten-a-day caps for texts and new-lead buzzes count
    from the owner's local midnight. The tenth text ends "That's today's last text; the rest wait
    in the app." Leads that came in before the owner's midnight read "waiting on you" ("Squared
    Away: 45 quote requests are waiting on you. Open: …"; push "N quote requests are waiting on
    you"). `secondsUntilQuiet` (until 9pm local, ≤ 4h, ≥ 60s) is the push TTL for new-lead and
    at-risk pushes and the text's `ValidityPeriod` (Messaging Service only). Emergency alerts keep
    the default 4-hour TTL (they are meant to arrive at night).
  - **Get the app (C46 P1, P2):** `installSteps(ua, maxTouchPoints)` in `src/lib/install-steps.ts`:
    iPhone Safari on iOS 26 (three dots / Share / Open as Web App left on), Chrome/Edge/Firefox on
    iPhone (Share in the address bar), iPad = a touch-screen "Macintosh" → iPhone Safari steps,
    Android any browser (the menu), computer (the address bar's install icon; the only case that
    mentions "your phone"). The browser's own Install button still wins.
  - **Manifest (C46 P4):** `screenshots` (3 × 1080x1920, form_factor narrow) from
    `scripts/app-shots.mjs` (invented e2e seed data only; run against the local e2e app with
    `pnpm exec tsx scripts/app-shots.mjs`), `lang: "en-US"`, `dir: "ltr"`. id/start_url/scope/icons
    unchanged. pwa.spec asks Chrome's `Page.getInstallabilityErrors` in a persistent profile.
  - `security-surface.test.ts` has two new routes: `/api/push/subscription` (session) and
    `/api/twilio/status` (new guard kind `twilio-signature`).

## Davi to-dos (docs/LAUNCH.md)

- When Twilio goes live: nothing new to set — the status callback is signed with
  `TWILIO_AUTH_TOKEN` and goes to `APP_URL/api/twilio/status`. `ValidityPeriod` only applies with
  `TWILIO_MESSAGING_SERVICE_SID` (recommended anyway).
- Look at the install sheet on a real Android phone once (screenshots), and the status bar badge
  ("sa." should show, not a square).

## Privacy policy lines

- Under "What we store": "For each text alert we send you, whether your carrier delivered it (the
  message's id from our texting provider, its status and error code — never the text or your
  number), kept 30 days." and "If texts stop because you replied STOP or the number can't take
  texts, we note which."
- Under phone notifications: "If your phone's notification service keeps refusing our
  notifications for 7 days, we forget that phone's notification address."

## Questions for Davi

- None blocking. Built the safe defaults:
  - Emergency pushes still may arrive late at night (that is their point); only ordinary and
    at-risk pushes stop at 9pm.
  - A STOP reported by Twilio turns texts off until the owner turns them on again in Settings.
