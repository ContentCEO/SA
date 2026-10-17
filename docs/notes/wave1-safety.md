# Notes for the integrator: branch `wave1-safety` (wave 1, group "Safety guards")

Builder notes for `CLAUDE.md` (Decisions, Prompt versions, Waiting on Davi), `docs/LAUNCH.md` and
`docs/privacy-policy.md`. Nothing here has been written into those files.

## Prompt versions

- **classify.v5** (this branch): Check 22 P4 + 36 P1 (smells_gas widened, `co_alarm` signal).
  Later steps on this branch add to the same file (see below). The categories, business block and
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

## Questions for Davi

1. **Carbon monoxide safety note wording** (built, waiting on okay before merge to production):
   "If your carbon monoxide alarm is going off, please don't wait on email. Get everyone out of
   the house into fresh air right away, pets too, and call 911 from outside. Don't go back in
   until the fire department says it's safe. / I'll call you as soon as I can." This follows the
   usual fire-safety advice (leave, call 911 from outside, stay out until the fire department
   clears it); please confirm against your local fire department's wording.
