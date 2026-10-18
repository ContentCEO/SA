# Notes from wave 2: Town, utility and job-kind lists (branch `w2-lists`)

## Decisions (for CLAUDE.md)

- **Town check narrowed and widened (Check 22 P8, 36 P5, 37 P6, 40 P7, 44 P4, 45 P3):**
  `readMunicipal(fromAddress, fromName, subject?)` in `src/ai/guards.ts` (`looksMunicipal` is its
  boolean, with an optional third `subject` argument). Domain rules unchanged (.gov, <town>.<st>.us,
  townof…), plus an exact list of town .org/.com domains in `src/config/municipal-domains.ts`
  (littletonma.org, sherbornma.org; each with its source; no broad patterns). A name-only match no
  longer counts when the name (with the town-office words taken out) has a company word (inc, llc,
  co., corp, company, group, services, ltd, pllc, "& sons"); words private companies share
  ("building inspections", "public works", street/dumpster/right-of-way permits) count only with
  town/city/county or DPW in the name. A name-only match from public webmail (gmail.com etc.) is
  **not** the town: it stores `extracted.municipal_name_only = true` and the Inbox row shows
  "Careful: Says it's a town office but writes from a personal address." Names added: water and
  sewer offices, water districts, cross-connection / backflow programs, DPW, Sun Belt / West Coast
  building office names. Permit portals also count on a notice subject (permit, inspection, record,
  application, license) unless it reads like marketing (webinar, demo, newsletter…). Portals added:
  `mgoconnect.org`, `permiteyes.us`.
- The round 2 TW A5 tests that used `x@gmail.com` with a town name now use `x@example.org`
  (Check 22 P8 makes the gmail ones a caution); a gmail row checks the caution.

## Davi to-dos

- Confirm `permiteyes.us` (PermitEyes / Full Circle Technologies) and `mgoconnect.org` from a real
  notification email header a pilot shop received. Both are in the portal list from the review's
  probe only. Tyler EnerGov, iWorQ, SmartGov were not added (no real header seen).
- Before adding any other town domain to `src/config/municipal-domains.ts`, check it on the town's
  own staff directory.

## For the Prompt versions group (next classify version)

- Check 36 P5: add "water and sewer departments, water districts and their backflow or
  cross-connection programs" to the town list, and "backflow test due notices" to the never-noise
  paperwork list (customer_question, or scheduling when it sets a date).
