# Notes from `m12-sms-summary` (plan #50, the remaining parts)

Base 305906e. For the integrator: fold into `CLAUDE.md` / `docs/decisions/queue-and-sending.md`
(next to "Text alerts (2026-10-09, plan #50)") and `docs/LAUNCH.md` step 13, then delete this file.

## Migration

- `0081_sms_summary_texts` (additive, no backfill): `business_profile.sms_summary_enabled`
  (boolean, default false), `sms_summary_last_sent_on` (text 'YYYY-MM-DD', null),
  `sms_at_risk_enabled` (boolean, default false). Renumber at merge if another branch took 0081
  (the Outlook builder may add one).

## What turns it on

Nothing new. Both texts need the existing Twilio env (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
and `TWILIO_MESSAGING_SERVICE_SID` or `TWILIO_FROM_NUMBER`) **and** each owner's own opt-in on
Settings → Text alerts. Without the Twilio env the screen stays hidden and nothing is sent or
marked. No feature flag: the owner's switch (default off) is the switch, as for new-lead texts.

## Decisions (for the decisions file)

- **Plan #50 remaining parts (2026-10-24, branch `m12-sms-summary`):** two more owner texts,
  each its own switch, default **off**, shown and active only while `sms_alerts_enabled` is on.
  That one master switch is what a STOP (send-time 21610 or a delivery report), "not a mobile"
  (30006) and "Remove my number" turn off; they now also clear both new switches
  (`ALL_TEXTS_OFF` in `sms-delivery-rules.ts`), so after START the owner turns each back on.
  Every text asks `textsOn(p)` (confirmed number, alerts on, no `sms_stopped_reason`).
  Trade-off on purpose: an owner can't get the summary without new-lead texts on (one switch
  for STOP to flip; emergencies already work that way). Davi can ask for "summary only" later.
- **Morning summary by text** (`src/server/sms-summary.ts`, rules in `sms-summary-rules.ts`): a
  third step (`texts`) of the hourly `morning-digest` job. Due at/after `digest_hour` in the
  owner's zone, once a local day, **before noon** (`SUMMARY_TEXT_LAST_HOUR` 12: no "morning"
  text in the afternoon), never in quiet hours (a 5am/6am hour waits for 7am), never for
  read-only accounts (`jobsAllowed`). **Independent of `digest_enabled`** (its own switch; the
  safe default is off). Counts from `digestCounts` (the queue's content-free membership): "N
  replies ready, N follow-ups ready, N need you" (needs you = needs-you cards + waiting leads
  with no card + not-answered-yet), link `/queue` (or `/quotes` when the only thing waiting is
  a lead with no card). A quiet morning: no text and the day is marked done. Otherwise the
  shared text slot is claimed (10-minute gap, and only while today isn't marked), then sent;
  the marker `sms_summary_last_sent_on` is written **only after Twilio accepted it**; refused /
  not configured / STOP → slot handed back, nothing marked. Activity `sms_summary_sent`
  {replies, followups, needsYou, deliveryId} ("Texted you this morning's summary" once
  delivered). Failures are logged (`sms_summary_failed`: workspace id, Twilio status, error
  name) and don't fail the job, like the new-lead texts.
- **Leads at risk by text** (`sendLeadAtRiskPushes`, `src/server/leads-at-risk.ts`): the same
  run, the same moment and the same episode marks as the plan #34 push — one
  `atRiskAlertedAt` mark covers push and text, so a lead is never alerted twice. Owners with
  `sms_at_risk_enabled` count even with no phone subscribed. Text = "N quote requests have
  waited over 4 hours. Open: …" (link from `notificationUrl`: the lead's queue card, else
  `/quotes`). Shares the at-risk allowance (`LEAD_AT_RISK_PUSHES_PER_DAY`, one
  `lead_at_risk_push_sent` row per episode, now with `texted: true` + `deliveryId` when texted),
  quiet hours, business hours, the 10-minute text slot and the ten texts a day. A refused text
  hands its slot back (as `alertOne`); STOP turns every text off; if neither a phone nor the
  text took it, the marks are taken back and nothing is logged.
  When only one of the two slots is free (a new-lead push or text in the last 10 minutes), the
  alert goes by the free one and the episode is marked: the owner heard once, so the other
  channel doesn't repeat it later for the same wait.
- **Ten texts a day, shared:** `textsSentToday` counts `sms_alert_sent`, `sms_summary_sent`
  and `lead_at_risk_push_sent` rows with `texted: true`, from local midnight. The tenth of any
  kind ends with "That's today's last text…". Emergencies keep their own caps (unchanged).
  `LAST_TEXT_OF_DAY` moved to `sms-summary-rules.ts` (re-exported from `sms-alerts`).
- New `SmsErrorCode` `alerts_off` ("Turn on text alerts first.").
- Delivery rows for both use kind `alert` (no new kind).

## LAUNCH step 13 (Davi)

- When registering the A2P 10DLC campaign (docs/SETUP.md §6c step 3), add the two new sample
  messages (already in SETUP): `Squared Away: 3 replies ready, 1 needs you. Open: https://…/queue`
  and `Squared Away: 2 quote requests have waited over 4 hours. Open: https://…/quotes`. A
  campaign approved without them may get these texts filtered (30007).
- Each extra text costs a segment like any other (≤ 1 a day for the summary, ≤ 3 a day for
  waiting quotes, all inside the existing 10 a day per owner).
- Decide later whether an owner may get the morning text without new-lead texts (see the
  trade-off above).

## Expected conflicts with the Outlook builder (#49)

- `src/app/(app)/settings/messages.ts` (new `/settings/texts` keys) and possibly
  `src/app/(app)/settings/page.tsx` if they touch it (this branch doesn't).
- The migration number (0081) and `drizzle/meta/_journal.json`.
- `docs/FEATURE-PLAN.md` (each ticks its own line).

## Tests

- `tests/unit/sms-summary.test.ts` (21): words + property test over counts, due rules, off by
  default, once a local day, hour / noon / quiet hours / time zone, independent of the email,
  quiet morning, read-only, text alerts off / unconfirmed / STOP on file, STOP on send and in a
  delivery report and Remove my number turn all three off, shared cap + gap + last-text line,
  two runs at once, Twilio unset (nothing sent or marked), a refused text isolates owners with a
  content-free log, a property test over customer fixtures (names, emails, subjects, amounts,
  links) that no fixture value reaches a text, no network with the injected sender, switches.
- `tests/unit/sms-at-risk.test.ts` (15): off by default, text only, push + text as one episode,
  re-armed by a new wait, business/quiet hours, read-only, STOP, refused text with and without a
  push, Twilio unset, shared slot and ten a day, the tenth's line + shared cap with new-lead
  texts, the 3-a-day at-risk cap, two runs at once.
- `tests/unit/sms-texts-screen.test.ts` (4): the screen's numbers come from `SMS` and the
  `LEAD_AT_RISK_*` limits, nothing typed; each outcome has a notice.
