# wave1-home (Homepage words, wave 1 steps 1–7)

Notes for the integrator: what `CLAUDE.md` should say after this branch merges. No migration, no
prompt change.

## For CLAUDE.md (Decisions)

- **Homepage copy module (wave 1, Homepage words):** the homepage's steps, feature cards, FAQ,
  promise band and pricing paragraph live in `src/components/marketing/home-copy.ts` (pure);
  `src/app/page.tsx` renders them, and tests read the strings as visitors see them
  (`homepageFaq()` in `legal-docs.test.ts` now looks the answer up in `faqs`). Plan cards are
  `src/components/marketing/plan-cards.tsx`, keyed on plan ids.
- **Rule numbers in one pure place:** `src/config/rules.ts` holds `EARN_THRESHOLD`,
  `GRACE_MINUTES` and `MAX_FOLLOWUPS` (re-exported from `src/server/autopilot.ts` and
  `src/server/drafts.ts`, so callers didn't change). The homepage builds every rule number from
  them (`numberWord()` in `src/lib/number-words.ts` spells 1–10).
- **Trial length words:** `src/lib/trial-words.ts` (`dayWord`, `daysPhrase`, `dayAdjective`);
  nothing in `src/` types "three days" / "three-day" / "Day N of 3" / "3 more days" (guard test
  in `tests/unit/trial-words.test.ts`, skipping `src/ai/prompts/` and comment lines; setup
  steps "Step 1 of 3" aren't the trial and aren't caught). `TRIAL_NO_SEND_LINE` is built from
  `pricing.evaluationDays`. The trial banner is `TrialClock` (`src/components/app/trial-clock.tsx`)
  and says the clock's own length (`daysPhrase(clock.of)`), so a trial extended in /admin reads
  "Day 3 of 6 · … your six days". `trialLengthDays(w)` (lifecycle.ts) gives the same length to
  the Send reply note and the after-trial reason/banner ("Your six days are up."). Activity:
  "Your three days started" (config), "Your trial ended", "Your trial was extended by three
  days". Practice copies say "During your trial, Squared Away only sends to you." Admin buttons:
  `Give ${evaluationDays} more days` / `Add ${evaluationDays} days`. A unit test fails with "ask
  Davi to update the terms" if `evaluationDays` changes while `docs/terms.md` says "three-day
  trial".
- **Plan lines by id:** `src/server/plan-features.ts` (pure): `FEATURED_PLAN`,
  `planFeatureLines(id)`, `autopilotPlanNames()`, `SIGN_INS_PER_PLAN`. Used by the homepage
  cards, `/billing` and autopilot's lock reason. No page compares a plan's display name.
- **First payment on the homepage cards:** each card shows `firstChargeLine(id, true)` (the
  setup fee always included for a visitor), as `/billing` does. The standalone "Plus sales tax
  where it applies." note is gone from the homepage and `/billing` (each card's line says it);
  `SALES_TAX_NOTE` stays exported.
- **Setup call wording:** `SETUP_CALL_COVERS` + `setupCallSentence("before" | "after")` in
  `billing-rules.ts`: "your prices, hours, service area and the things you never promise", then
  "tune your drafts until they sound like you". Used by the homepage setup box, `/billing`
  (before and after paying) and the setup_paid banner. "Scheduling" is gone.
- **Homepage feature cards (nine):** Knows your trade · Won't take orders from strangers · Sorts
  every email (with the morning summary as its last sentence) · Writes like you · Chases quiet
  quotes (only quotes the customer emailed about and the owner emailed back; "Quotes sent from
  other software are left to that software"; "I called them" stops it) · Every quote in one list
  (stage names from `stageLabel`) · Who owes you · Your customers, in one place · Your data stays
  yours. No "Buzzes you" card (phone alerts aren't live until the VAPID keys are in) and no
  Autopilot card (its rules are in the first FAQ, the plan cards and the pricing paragraph,
  which now also says autopilot never answers a complaint or sends a reply that mentions money).
- **Queue picture:** shows Send reply (across the card) with Edit and Discard under it, as the
  real card lays them out; no trial banner inside the phone; one caption under it: "Example.
  During your three-day trial it drafts like this, but won't send to a customer."
- **Join button:** the header says "Join the waitlist" (was "Get on the list"), like every other
  join action.

## For docs/LAUNCH.md / Davi's to-dos

- Read the new homepage words (preview), especially the FAQ "Can my office manager use it too?"
  and the plan line "1 Gmail inbox · 1 sign-in" (Check 42 P7 asks for Davi's okay on the exact
  words before merging).
- See "Questions for Davi" below.

## For docs/privacy-policy.md / docs/terms.md

- Nothing new to add. The homepage now matches the policy's retention and scope wording.
- `docs/terms.md` still says "three-day trial" (fine while `evaluationDays` is 3; a unit test asks
  for Davi if that changes).

## Questions for Davi

1. **Office manager FAQ and "1 sign-in" (Check 42 P7):** the FAQ answer reads: "Today each shop
   has one sign-in, yours. Crew and Company add more Gmail inboxes (3 or 10), not more logins. If
   someone in your office answers email, connect the office inbox, and call Davi to talk through
   who taps Send." The plan cards and /billing say "1 Gmail inbox · 1 sign-in" / "3 Gmail
   inboxes · 1 sign-in" / "10 Gmail inboxes · 1 sign-in". Okay to ship these words?
2. **Phone alerts card:** the "Buzzes you when it matters" card was left out because phone
   notifications are off until the VAPID keys are added. Once they're in, add the card?
3. **Morning summary:** the Sorts card and the plan cards still say "morning summary", but until
   the Resend domain is verified it only reaches the Resend account's own address. Keep it, or
   take it off until the domain is done?
4. **Autopilot card:** dropped to keep the grid at nine cards (it's said three other times on the
   page). Fine, or swap it back in for another card?
5. **Naming Jobber and Gmail's AI** in the new FAQ "How is this different from Gmail's own AI, or
   from Jobber?" (no prices of theirs). Okay to name them?
