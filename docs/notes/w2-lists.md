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

## Step 2 (Check 37 P3): the electric company

- Decision: `looksLikeUtility(from, name)` (`src/ai/guards.ts`): eversource.com, nationalgrid.com,
  nationalgridus.com, unitil.com (and subdomains); a big utility's NAME counts only from those
  domains; a light plant's name ("Light Department", "Light Plant", "Electric Light",
  "Light & Power", "Municipal Light") from any domain but public webmail. Checked before the town
  check, so a light plant on .gov is the electric company. Stored as `extracted.utility`: skips
  the Promotions shortcut, never junk (noise → scheduling with a date, else customer_question),
  never drafted by a job (`skipped: utility`; the owner's tap still drafts), autopilot refuses
  ("The electric company always waits for you."), batch send treats it as untrusted. With a date:
  needs you, "From the electric company about a job date. Check it with your crew and the
  customer." (owner-rule key `utility`, fixed text).
- Decision: `looksLikeUtilityScam(text, from, name)`: a big utility's name from another domain
  that wants payment, or anyone threatening a shutoff within hours/today and naming a gift card,
  prepaid card, Green Dot, MoneyPak, Vanilla, Reloadit, Bitcoin/crypto, Zelle, Cash App or Venmo.
  Sets `payment_change` (so every payment-change stop applies) and `utility_scam` (sticky for the
  thread), needs you, high: "Says it's from the electric company and wants payment now. Don't pay
  from this email; call the number on your bill." Owner-rule keys `utility_scam` + `payment_change`.
  Also caught past the AI limit (code-only result).
- Davi to-do: confirm the four utility domains from real emails (Eversource, National Grid,
  Unitil notices a pilot shop received). Until then they're the companies' public web domains.
- Known edge: rule (b) has no sender check, so a customer writing "we'll shut off the power today,
  I'll pay you by Venmo" is flagged as a scam (needs you, no job draft). Safe direction.
- Prompt versions group (next classify version): add "electric company work requests,
  cut-and-reconnect appointments, meter sets, planned outages for a job, interconnection
  approvals" to the never-noise paperwork line.

## Step 3 (Check 36 P4 + Check 37 P2): town emails on the Queue

- Decision: every town email (code or the model's signal) that isn't junk needs the owner, with a
  fixed line from its permit facts only (`municipalReason` in `src/ai/classify.ts`): "From the
  town: inspection failed, N things to fix." / "… inspection scheduled." / "… inspection passed."
  (priority normal) / "From the town." Owner-rule key `municipal` (fixed text: the model's words
  never ride along). Injection, gas, CO, electrical, payment change and the utility scam still win.
  Only the owner's tap drafts to the town, as before. The owner rules now read the kind the
  email ends up with (a town or utility email the model called junk is re-sorted first).
- Decision: permit facts carry across emails on a thread (`carryPermitFacts`,
  `src/server/permit-rules.ts`): same permit (number, or same issuing body when a number is
  missing) keeps the fix list until it passes; new corrections replace it; a different permit
  replaces everything; an attack email never changes it. Retention purge unchanged.
- The permit card (and the town caution) shows on the Queue's Needs-you card and draft cards; the
  folded Inbox row says "Permit E-26-0412 · 3 things to fix". The Failed badge now uses
  `bg-primary text-primary-foreground` so it stays inverted on a charcoal card too.
- Eval cases with `municipal: true` now expect `needsOwner: true`.
