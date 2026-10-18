# Notes from `w2-settings` (wave 2, "Settings and time zone")

Steps: 1) C15 P1; 2) C45 P1 + C44 P5 + C15 P7 [M]; 3) C15 P2; 4) C15 P3; 5) C15 P4; 6) C15 P5; 7) C15 P6 + C24 P11; 8) C15 P8 [M]; 9) C43 P8 [M]; 10) C15 P9 + C15 P10 + C15 P11 + C15 P12.

## Migrations (numbered on 2a580e0; renumber at merge)

- `0044_time_zone_source`: `business_profile.time_zone_source` text not null default `'default'`.
- `0045_work_hours`: `business_profile.work_days` int[] default `{1,2,3,4,5,6}`,
  `work_start_hour` int default 7, `work_end_hour` int default 18.
- `0046_reply_languages`: `business_profile.reply_languages` text[] default `{"en"}`,
  `drafts.customer_language` text, `drafts.reply_language` text.

All additive. No prompt files changed (adaptation 4).

## For CLAUDE.md (Decisions)

- **Money box (Check 15 P1):** "Send me anything that mentions more than" reads "2,500" / "$2,500";
  a blank box is refused ("Leaving it blank would send you every email with a price in it."),
  never saved as $0. Decimals, negatives, words and > 10,000,000 refused in plain words. The box
  shows the saved amount with a comma. Default ($2,500) and the rule unchanged.
- **Time zone (Check 45 P1 + 44 P5 + 15 P7):** `business_profile.time_zone_source` = `default`
  (never set) | `browser` | `owner`. `ZoneCapture` (`src/components/app/zone-capture.tsx`, gated
  by `zone-capture-gate.tsx` in the (app) layout: signed in, terms agreed, source `default`) posts
  the browser's zone once to `saveDetectedTimeZoneAction` (requireOwner; `saveDetectedTimeZone`
  saves only while the source is still `default`, creating the profile row if there is none;
  activity `time_zone_detected`, no detail). Because that row now often exists before setup, `saveBusinessProfile` sets `completed_at` on conflict too (`coalesce`, so later saves keep the first date); before, a pre-existing row (e.g. from Follow-ups settings) never got marked done. Setup's hidden `TimeZoneInput` still saves the
  browser zone as `browser`, never over `owner`; `saveBusinessProfileAction` drops `timeZone`
  unless `returnTo` is the setup screen, so a /settings/profile save never moves it. Away mode
  uses the posted browser zone only while the source is `default` (it used to replace any saved
  Eastern zone). Settings → Morning email: no hidden zone any more; a visible "Your time zone"
  select (US zones from `src/server/time-zone-rules.ts`, plus the saved zone if it isn't one of
  them), "Times are in Eastern time (New York, Boston). It's 7:42 am there now.", and — when the
  phone's clock differs — "This phone is on Central time." + "Use Central time" (saves at once
  through `takePhoneZoneAction`, requireOwner + isTimeZone). A changed zone is saved by
  `setOwnerTimeZone` as `owner` and logged `time_zone_changed` {from, to} (zone names only);
  `saveDigestSettings` no longer writes the zone. Settings list: "On · 7:00 am Eastern"; Text
  alerts: "Not between 9pm and 7am Eastern time". Playwright now runs every page with
  `timezoneId: "America/New_York"` (playwright.config.ts) so captured zones match the old default.
- **Plain Settings errors (Check 15 P2):** every rule in `src/server/profile.ts` has its own
  message (a unit test runs every schema against bad input and fails on Zod's wording).
  "People who always need you" takes Gmail-style pastes ("Sue Smith <sue@x.com>", commas or
  semicolons); a bad line is named: "This line isn't an email address: “Sue Smith”." (no "VIP"
  word). The voice form has the "A couple of things need fixing below." banner.
- **Ways back (Check 15 P3):** `BackLink` / `CancelLink` (`src/components/app/back-link.tsx`):
  "< Your business" and "< Your voice" above the two edit screens' headlines, and a Cancel under
  each form's main button (Settings only, not setup). SettingsScreen uses the same BackLink.
- **Your business shows every fact (Check 15 P4):** `describeProfileFacts` (pure,
  `src/server/profile-facts.ts`): Price list (3 lines, then "and N more"), Booking out, Hours,
  Work, Area, Other trades, How you get paid, Customers should know, Signature, Never promise,
  People who always need you, Send me anything over, then Business, State, Review link,
  Licenses; an empty one says "Not set." and what that means. Each row's "Change" goes to
  `/settings/profile#<field>`; the form scrolls to and focuses the field by its `name` (no new
  ids). Booking out and Seasonal notes sit at the top. Settings list: "Elm Electric · Price list:
  N lines" / "No price list yet".
- **Never-lists (Check 15 P5):** wording only (lists not merged, checks unchanged). Your voice:
  "Drafts try not to say “…” and flag it if they do."; voice form: "Words that don't sound like
  you"; doNotPromise hint says rewritten once, then flagged. `saveNeverSay` returns
  `{saved, skipped}`; skipped lines → `?done=never_say_skipped&saved=N&skipped=M`; SettingsScreen
  fills `{saved}` / `{skipped}` only from 1–4 digit numbers (`fillCounts`), else "Saved.".
- **Sign-off once (Check 15 P6):** the signature box is "What goes under your name?" with a link
  to Your voice. `signatureWithoutSignoff` (`src/server/signature-rules.ts`) drops the
  signature's first line when it equals the learned sign-off (case, spaces, trailing
  punctuation ignored) in `workspaceContext` — drafts, nudges and revisions. Saved text unchanged.
- **No greeting / no sign-off (Check 24 P11):** `voiceEditInput` greeting / sign-off optional
  (empty → null); "I don't use one" checkbox under each box (`noGreeting` / `noSignoff`, wins
  over typed text). `describeVoice`: "You usually jump straight in." / "You don't sign off.".
  draft.v6's `line()` already prints "not given" (never "null"), tested.
- **Working days for alerts (Check 15 P8):** `business_profile.work_days` / `work_start_hour` /
  `work_end_hour` (defaults = the old Mon–Sat 7am–6pm). Settings → Your business → "Your working
  days (for alerts)" (seven day boxes, start / end selects, `workHoursInput`: ≥1 day, start <
  end, 0–24). `workHoursOf` falls back to BUSINESS_HOURS for anything that doesn't make sense.
  `leadsAtRisk` reads the workspace's hours when the caller doesn't pass them (digest, push
  summary); `sendLeadAtRiskPushes` uses each owner's own. Free-text hours stay for drafts only.
- **Reply language (Check 43 P8):** `src/ai/language.ts` (pure): `detectLanguage` (stop-word
  count, en / es / pt, null when short or unclear), `chooseReplyLanguage` (the customer's
  language when switched on, else English), `languageCardLine`, `languageMismatchFlag`,
  `replyLanguageLine`. `business_profile.reply_languages` (English always; Spanish / Portuguese
  switches on Settings → Your voice, "Turn one on only if you can read a reply in it before you
  send."). `createDraftForThread` stores `drafts.customer_language` / `reply_language` (codes
  only); `checkDraft({ replyLanguage })` flags "This reply is in English, but you asked for
  Spanish." (hit `language`, cap 0.5, never regenerated); a revision keeps the stored language.
  The card shows "They wrote in Spanish. Reply in Spanish." / "… Reply in English (Spanish is
  off in Settings)." **The prompt doesn't say the language yet** (see below).
- **Settings polish (Check 15 P9–P12):** seasonal notes read "Until Sun, Nov 30" (year only when
  not this year; `src/lib/plain-date.ts`, no time zone shift); Add note is a `useActionState`
  form (`addSeasonalNoteFormAction`) that keeps what was typed and shows the schema's / the
  refusal's own message under the box (the old redirect codes stay in SCREEN_MESSAGES for old
  links). Your Gmail: "1 email from the last 30 days." (`src/server/gmail-screen-rules.ts`), the
  check time only in the health list. The main trade is hidden from "other trades" (client
  state; `cleanExtraTrades` still guards), and each trade has its own services example
  (`servicesExample` in `src/config/trades.ts`). Morning email mentions the monthly note once;
  Autopilot says "any reply that mentions a dollar amount or an invoice email that names one".

## For the Prompt versions group (Check 43 P8, Check 24 P11)

- Add to the conversation block of the next draft and follow-up versions (draft.v9 /
  followup.v5), right after the "What it is" line, the exact line from
  `replyLanguageLine(choice)` in `src/ai/language.ts`:
  - `Reply language: Spanish` (customer wrote Spanish, Spanish on), or
  - `Reply language: English (the customer wrote in Spanish; use short, plain sentences)`.
    `createDraftForThread` already computes `language` (a `LanguageChoice`) before the
    conversation block is built; pass it in. Revisions: use the draft's stored `reply_language`.
- Instruction line suggestion: "Write the reply in the language named on the 'Reply language'
  line, whatever language the customer wrote in."
- Eval cases to add with it (tests/evals/cases.ts): a Spanish quote request with Spanish off
  (expect English, plain sentences, no language flag) and with Spanish on (expect Spanish).
- Optional (Check 24 P11): with a ready voice and a null greeting / sign-off, the voice block
  prints "Usual greeting: not given"; it could say "none — they jump straight in" /
  "none — they don't sign off".

## Davi to-dos / questions

- "Use Central time" saves at once (Check 44 P5). Check 15 P7 said it should only fill the
  select. Built: save at once (a deliberate tap; the select + Save also works).
- Owners whose profile exists from before this change have `time_zone_source = 'default'`, so
  their next signed-in page load sets the zone from that browser once. If Davi has helped an
  owner on his own laptop, that owner should check Settings → Morning email.
- The per-trade services examples in `src/config/trades.ts` are first drafts: Davi may want his
  own wording.
- The three never-lists stay separate (Check 15 P5 says merging is Davi's call).
- Spanish / Portuguese replies: until the prompt line lands, a draft in the wrong language is
  only flagged on the card.

## Privacy / terms

- Nothing new leaves the app (no new hosts). New stored data: the zone's source, working days
  and hours, reply languages, and a language code on each draft — none of it email content.
