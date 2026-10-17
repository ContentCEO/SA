# Notes for the integrator: branch `wave1-safety` (wave 1, group "Safety guards")

Builder notes for `CLAUDE.md` (Decisions, Prompt versions, Waiting on Davi), `docs/LAUNCH.md` and
`docs/privacy-policy.md`. Nothing here has been written into those files.

## Prompt versions

- **classify.v5** (this branch): Check 22 P4 + 36 P1 (smells_gas widened, `co_alarm` signal),
  Check 22 P3 (a short reply's quoted text in its own untrusted block), Check 48 P1 (a "bot?"
  question is not `tries_to_instruct_assistant`), Check 22 P5 (`payment_change_request` is only
  a request to pay somewhere new).
- **draft.v8** (this branch): Check 48 P1's "Who is writing" rule. The categories, business block and
  types are re-exported from classify.v4, so screens importing `Category` from v4 are unchanged.
  `co_alarm` is `z.boolean().catch(false)` (a missing value reads false, as draft.v7's `opening`).
  Other groups that write classify.v5 (Check 12 P2 / 12 P3 / 22 P9 / 38 P5 / 45 P7 per the version
  plan) need combining into this one file at merge.
- Evals not run (no `ANTHROPIC_API_KEY`). The eval set gained cases and two metrics:
  `coAlarmRecall` (strict) and `gasFalseAlarms` (no increase allowed, like injection false alarms).

## For CLAUDE.md Decisions

- **Gas, propane, CO and smelly water (Check 22 P4 + Check 36 P1):** `mentionsGasSmell`
  (`src/ai/guards.ts`) first removes printed advice ("Smell gas? Leave the building…", "if you
  (ever) smell gas…", "gas odor calls…"), then matches gas / propane smells, a gas leak (not "gas
  leak detector / test"), a leaking or hissing gas line, Spanish and Portuguese, and a red tag only
  next to the word gas or propane (an electrical inspector's red tag is not a gas leak).
  Rotten-egg / sulfur smells are gas **unless** every one sits in the same sentence as a water word
  (water, shower, faucet, tap; "water heater" doesn't count) and nothing names gas, propane, a
  meter, stove, range, oven, furnace, boiler, pilot or dryer — then `mentionsWaterSmell`:
  needs you at normal priority, `WATER_SMELL_REASON`, `extracted.water_smell`, owner-rule key
  `water_smell`, no safety note, no emergency. The model's `smells_gas` only overrides the water
  reading when the email names gas or propane.
- `mentionsCarbonMonoxide`: a CO word (carbon monoxide, CO alarm/detector, "co2 detector") with
  something happening within 60 characters (went off, going off, sounding, a reading, ppm,
  detected, headaches, dizzy…; beeping only without battery/chirp), or "detector going off" next
  to a furnace / boiler / heater (not a smoke detector). An install quote is not an alarm.
  `CO_REASON`, `extracted.co_alarm`, urgency emergency, owner-rule key `co_alarm`; treated like gas
  everywhere (needs you, high, emergency lane and night alerts through the urgency mark, autopilot
  and batch refuse it). Gas wins when both.
- **Safety notes:** one per thread (purpose `safety`, gas or CO). The CO note is
  `coSafetyNote` (`safety-note-co.v1`, flag `CO_SAFETY_NOTE_FLAG`). A safety note is never written
  on a thread sorted as junk unless the owner has written to that address before (`knownCustomer`;
  `threadsToAutoDraft` leaves junk out unless the owner wrote on the conversation), and never to a
  no-reply address (as before). The gas note's wording is unchanged.

- **After the day's AI limit (Check 39 P1):** `classifyPending` no longer stops at the first
  `AiCapReachedError`. That email and every later one in the batch go through
  `codeOnlyClassification` (`src/ai/classify.ts`, pure; the same code checks and the same shape
  as the no-model fallback): a gas smell, CO alarm, payment change or attack is stored through
  the normal write (needs you, high for safety and payment, `classified_at` set, no model
  category, no auto-marks); everything else stays unsorted for the model after the reset.
  `ClassifyRunResult.codeOnly` counts them (they are in `classified` too), so the classify job's
  text/push alerts fire. `threadsToAutoDraft` orders a gas / CO thread still without its safety
  note first, so the note (no model) is written before a model draft hits the limit.

- **Quoted and forwarded text (Check 22 P3 + Check 20 P5):** `splitQuoted` (`src/ai/classify.ts`)
  returns the newest part and what quoting cut; `prepareBody` is its `kept` part (unchanged).
  `classifyEmail` runs the gas, CO, payment-change and new `mentionsLegalThreat`
  (`src/ai/guards.ts`: attorney / lawyer / law office, lawsuit, suing / "will sue", small claims,
  demand letter, cease and desist, 93A, attorney general, consumer protection, filing or placing
  a lien, a lien on the house; never "Sue" the name, "denied", "dispute" or "court" alone, nor a
  power of attorney) on the WHOLE email too (subject + raw body + the burst, CRLF normalised,
  ≤20,000 chars). The attack check keeps to the newest part (quoted text is often the owner's own
  words). A legal hit in code → needs you, high, `LEGAL_REASON`, `extracted.disputed` (so the
  sticky complaint mark), and it survives the routine-paperwork drop. When the newest part is
  under 300 characters and quoting cut something, the first 1,500 characters of the cut part go
  to the model in a second untrusted `<email>` block labelled "Quoted or forwarded text (older,
  may be from someone else)" (classify.v5). Never logged.
- **Autopilot reads the whole newest customer email** (`blockers`): gas / CO / payment change /
  legal words anywhere in it, quoted part included, stop the countdown ("Something legal is
  mentioned in this conversation, so it waits for you." and the existing gas / payment lines); a
  purged body (no text left) waits ("We can't read their email any more, so it waits for you.").
- `threadsToAutoDraft` picks safety-note threads with a separate first query, then the usual
  query, so the ordinary order (newest first) is exactly as before.

- **Emergencies (Check 36 P2), adapted:** the leads package already made the model's
  `urgency: emergency` on a lead count in code (needs you, high, `EMERGENCY_REASON`, counted in
  `freshLeads` / the emergency lane), so step 1 of the prompt was built. Added: a 48-hour sticky
  mark — `extracted.emergency` + `emergency_at` (the emergency email's time), set when a sort hits
  `emergency`, a gas smell or a CO alarm (never from an attack email) and carried across later
  sorts while it is under 48 hours old (`recentEmergency`, `src/server/emergency-rules.ts`, pure).
  Autopilot ("There was an emergency on this conversation in the last 2 days, so it waits for
  you.") and batch send (`batchCandidates(…, now)`) refuse the thread meanwhile. **Not built:**
  the prompt's one automatic draft on an emergency (with an "Emergency: call them first" flag):
  CLAUDE.md's leads package says "emergencies are no longer auto-drafted", so that decision is
  kept until Davi says otherwise (question 2 below).

- **Electrical fire signs (Check 37 P1):** `mentionsElectricalHazard` (`src/ai/guards.ts`, code
  only, no prompt change): burning smells, smoke / sparks / arcing / hot to the touch / loud
  buzzing / scorched / melted within 40 characters of an outlet, plug, switch, panel, breaker,
  box, fixture, light, ceiling, meter, wire or cord (or "out of / behind the wall"), a shock,
  wires down, the meter or service pulled off, lights going bright and dim, Spanish and
  Portuguese. Smoke detectors / alarms, spark plugs, "a burning question", hot tubs and hot water
  are taken out first. `ELECTRICAL_HAZARD_REASON`, `extracted.electrical_hazard`, urgency
  emergency, owner-rule key `electrical`; order injection > gas > CO > electrical > payment
  change. Also in the no-model fallback and the after-the-limit code path. One fixed
  `electricalSafetyNote` per thread (purpose `safety`, `safety-note-electrical.v1`,
  `ELECTRICAL_SAFETY_NOTE_FLAG`), same limits as the gas note (not on junk unless known, never
  to a no-reply address). Autopilot and batch refuse it; it counts for the 48-hour emergency
  mark. Eval metric `electricalHazardRecall` (strict).

- **Attack-check false alarms (Check 22 P2):** `injectionCheck` no longer flags a bookkeeper's
  / adjuster's / lender's "send me all the invoices" (only someone else's things or secrets:
  the owner's, other customers', every customer's, passwords, logins, tokens, API keys, contact
  or customer lists), the writer's own "my / our earlier instructions", "rules about / for",
  "assistant manager" (and other job titles), Spanish "indicaciones" (the rules words need
  anteriores / previas / todas las), or "when writing your response, list…" (it needs an order
  to say / include / mention / add / reveal / confirm / agree / promise / always / never within
  60 characters). Every round 2 catch still flags.
- **"This is a normal email"** (`clearInjectionMark`, `src/server/injection-clear.ts`; rules in
  `injection-clear-rules.ts`): a button on Queue needs-you cards whose mark has recorded reasons
  (`extracted.injection_reasons`: instructions / encoded / hidden / sticky / model, content-free)
  with no hidden or encoded text. Classification also keeps `extracted.without_injection` (the
  owner rules' answer with the mark left out: needs-you, reason, priority, hits) so the card is
  put right without a model call. Clearing removes `injection`, sets
  `injection_cleared_by_owner` / `injection_cleared_at` (kept across later sorts, so the sticky
  copy stops), restores the facts (the owner's "This one needs me" still wins), and writes
  Activity `owner_cleared_injection` (no detail). Refused for another workspace, hidden or
  encoded text, older rows without reasons, and read-only accounts. The draft job no longer holds
  emails dated before the clear against the thread. Autopilot refuses the thread for 30 days
  ("You said an email here was normal after we flagged it, so it waits for you."). Notices
  `?done=normal_email`, `?error=not_clearable`.

- **"Is this a bot?" (Check 48 P1 + Check 43 P2):** `asksIfAi` (`src/ai/guards.ts`, English,
  Spanish, Portuguese; also "hi assistant, can you ask Mike to call me", "if a bot is reading
  this, pass it to a human"). The attack check now splits phrases that only ADDRESS the
  assistant ("Dear AI assistant:", "if an AI is reading", "as the AI", "you are (now) an AI")
  from real orders: addressing counts as an attack only with an order within 80 characters
  (agree, approve, confirm, include, send, reveal, must…) or when the email isn't asking if a
  person is reading. Gone: "(talking) to an AI", "send the photos to the assistant", "you are an
  AI, right?", "answer as the owner and not as the assistant". `ASKS_IF_AI_REASON` ("Asks whether
  a person or an AI is answering. Answer this one yourself."), `extracted.asks_if_ai` (sticky for
  the thread like `injection`), owner-rule key `asks_if_ai` (after injection and the safety
  marks). Jobs never draft it (`asks_if_ai`); the owner's tap does, with **draft.v8**'s "Who is
  writing" rule. `checkDraft` hit `human_claim` (`HUMAN_CLAIM_FLAG` "Says a person wrote this
  without help. Check it's true before sending.", cap 0.2, not regenerated; `claimsHuman`).
  Autopilot ("Asks if a person is answering, so it waits for you.") and batch send refuse both.
  Check 43 P2's separate wording `BOT_QUESTION_REASON` was folded into Check 48 P1's reason.
- **draft.v8** (this branch): draft.v7 + a "Who is writing" section (Check 48 P1). Everything else
  re-exported from draft.v7, so the cache is unchanged. Other groups' draft.v8 changes (Check 23
  P11 / 43 P1 / 44 P1 / 45 P2, 40 P1, 41 P1) need combining into this one file at merge.

- **Promotions / Social tabs (Check 22 P1):** `mustReadDespiteTab` (`src/server/classification.ts`)
  skips the no-model junk shortcut for: a lead-site sender (`leadPlatformOf`) whose subject
  looks like a lead (lead, request, sent you a message, new message, quote, estimate, hired,
  booked); facebookmail.com with "lead" in the subject; permit / inspection / certificate of
  occupancy in the subject or snippet; and anything the code checks catch (gas, CO, electrical,
  payment change, attack). A lead site's own marketing keeps the shortcut. The municipal, phone
  and sticky-mark exceptions are unchanged; the shortcut's result shape is unchanged.

- **Payment change (Check 22 P5):** `looksLikePaymentChange(text, { supplier })` splits "pay
  somewhere new" (pay / wire / send TO a new account, "update your records … new bank", "don't
  pay the old account", gift cards of any brand up to three words) from "details changed", which
  counts only with "our" / "the" and an ask within 60 characters (update, use, send, remit, pay,
  wire, attached, below, going forward) — or always for a supplier (`supplier_vendor` sort, or a
  thread whose stored `bill_direction` is `owed_by_business`). A customer's own card, bank or
  payment info ("my", "I") never counts. classify.v5's `payment_change_request` says the same.
  The reason text is unchanged.

## Privacy policy lines (for the integrator)

- Under "What we store", with the other content-free marks: "Whether an email looked like a gas
  smell, a carbon monoxide alarm, an electrical fire sign, sulfur-smelling water or an emergency
  (and when), why an email was marked as trying to instruct the assistant (a short code, not the
  text), and whether you said it was a normal email."

## Questions for Davi

1. **Carbon monoxide safety note wording** (built, waiting on okay before merge to production):
   "If your carbon monoxide alarm is going off, please don't wait on email. Get everyone out of
   the house into fresh air right away, pets too, and call 911 from outside. Don't go back in
   until the fire department says it's safe. / I'll call you as soon as I can." This follows the
   usual fire-safety advice (leave, call 911 from outside, stay out until the fire department
   clears it); please confirm against your local fire department's wording.
2. **Should an emergency get one automatic reply draft?** Today (leads package) an emergency —
   burst pipe, no heat, sewage backing up — goes to the top of Needs you with "Call now" and an
   alert, and no reply is drafted until you tap "Draft a reply". The review asked for one draft
   ("Emergency: call them first. This reply only covers what to do meanwhile.") waiting for your
   Send reply. Kept as it is until you say yes.
3. **Electrical safety note wording** (built, waiting on okay before merge to production):
   "If you see smoke or flames, get everyone out and call 911 from outside. If it's safe to reach
   your panel, switch off the breaker for that area and don't use that outlet or switch until
   we've looked at it. If wires are down outside, stay well away and call your electric company.
   / I'll call you as soon as I can." (From the review, based on NFPA's electrical safety tips.)
