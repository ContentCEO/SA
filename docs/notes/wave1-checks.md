# wave1-checks (wave 1, group "Draft checks")

Notes for the integrator: what CLAUDE.md should say, by step. Files in this group's area:
`src/ai/draft-checks.ts`, `src/ai/money-words.ts`, plus the new `src/ai/when-words.ts`.

## CLAUDE.md, under Decisions

- **Days and times as whole words (Check 20 P1 + 23 P3 + 23 P4, wave 1):** `src/ai/when-words.ts`
  (pure). `normalizeWhen` writes days, dates and times one way ("Fri" → friday, "8 a.m." → 8am,
  "Nov 27th" → november 27, "Mon–Fri" / "weekdays" → each day; "Sat", "Sun", "Wed" only when
  capitalised, since they are everyday words) and `whenTokens` turns them into keys; the check
  compares keys, never substrings ("fridge" no longer excuses "Fri"). New sources in
  `CheckContext`: `whenSourceText` (the conversation, seasonal notes **and their end dates**
  written "November 27", the owner's instruction / spoken words / a clean earlier draft — never
  the hours, lead time or policies), `hoursText` (its times always count; its days only with
  `allowHours`: the "Add my availability" tweak, or the customer asked when the owner is open,
  `asksWhenAvailable`), `leadTimeText` (only its "two weeks out" wording counts). Times now include
  "at 9", "around 8", "9:30", "9 o'clock", "10 a.m.", "in the morning"; loose timing adds "within
  the hour", "before the day is out", "by tonight", holidays as deadlines ("before Thanksgiving";
  any mention of the holiday in the conversation allows it), lead times ("three weeks out",
  "booked up through …"). A "today"/"tonight"/"tomorrow" whose only source is a customer email
  from an earlier local day gets "Says “tomorrow”, but they wrote that on Tuesday. Check the day."
  A never-promise item about same-day work is broken by "today", "tonight", "within the hour" or
  "before the day is out". Built in `whenContext()` in `src/server/drafts.ts` for new drafts and
  revisions. "This coming Friday" reads as Friday (the day token covers it).
- **Money however it's said, round 2 (Check 23 P1 + 20 P11 + 36 P10, wave 1):** `moneyMentions`
  now reads k-ranges ("3-4k" → 3000 and 4000; not "model 3-4K" or "10k BTU"), spoken prices
  ("fourteen fifty", "twelve-fifty", "nineteen ninety-nine", "one fifty to come out" — only next
  to a price word; for one to twelve only the clearly-price words, since "it's nine thirty" is a
  time), "ninety-five bucks", "a buck fifty", "a hundred and a quarter/half", "seven hundred
  fifty" (750) and "two thousand five hundred" (2500), €/£, "dólares"/"reais"/"pesos" (with
  "1.500" thousands), "R$ 1.500,00", "mil quinientos", and the price words es / cuesta (unos) /
  custa / fica em. New `vagueMoney()` ("low four figures", "a few bucks", "couple hundred
  bucks"): autopilot's `mentionsMoney` counts it, and checkDraft flags it (hit `money`, cap 0.3)
  "Gives a rough price (“low four figures”). Check you want to name a number." unless the owner
  wrote it. Soft promise "for free" (also free of cost / won't cost you / we'll cover it); an
  owner whose text offers free estimates may say "estimates are for free".
- **Claims, licenses and credentials (Check 23 P2 + 38 P6 + 36 P7, wave 1, migration
  `0039_licenses` on this branch — renumber at merge):** `business_profile.licenses` jsonb
  (`src/config/licenses.ts`: `hic_number`, `hic_expires_on`, `csl_number`, `lead_safe_license`,
  `insurance_carrier`; one line each, ≤40 characters). Settings → Your business → Edit business
  profile has a "Licenses and registrations (optional)" group (also in setup's optional
  section); a form without the fields leaves them alone, an emptied line clears it. Settings →
  Your business lists them and shows one line when the HIC runs out within 30 days (no email).
  **Never on the public site** (Davi: no license number published until confirmed). Drafting:
  `draft.v8`'s business block adds "Registration and licenses (quote exactly; never add
  others)" (so revise / follow-up / purpose prompts that share `workspaceBlock` see it too), and
  "Never invent" says never give another number or claim an unsaved credential; the numbers are
  owner text for the check. checkDraft: a number after HIC / CSL / CS- / MP- / JP- / MGF / LR- /
  license / lic. / registration / reg # (3+ digits) whose digits aren't in the owner's text →
  hit `license` ("Mentions a license or registration number you haven't saved. Check it.", cap
  0.3, in `REGENERATE_ON`), and the money finder never reads it as a price; "we're registered /
  licensed / lead-safe certified / insured" with the matching field empty and not in the
  owner's own words → hit `credential` ("Says you're registered and licensed. Add it in
  Settings or take it out.", cap 0.5, flag only). "Licensed" is also backed by a license
  number in the owner's text (a plumber's MP- in the signature). The old "licensed and
  insured" soft promise became these claims. Warranty / guarantee / promise words now compare
  with the owner's text only (a customer's "is that under warranty?" no longer excuses it). New
  soft promises: no permit needed (incl. "skip the inspection"), up to code, waived fee, price
  match, fit you in.
- **Prompt versions after wave 1 "Draft checks":** `draft.v8` (Check 38 P6 so far; later steps
  add to it). `draft.v8` re-exports draft.v7's reply schema / openings / first-contact task and
  draft.v6's conversation block; its `workspaceBlock` is v6's plus the licenses line.
- **Insurance-job promises (Check 40 P1, wave 1):** `INSURANCE_PROMISES` in draft-checks.ts —
  cover / waive / absorb / eat / take care of / pay the deductible, "insurance will cover",
  negotiating or dealing with the adjuster, handling the homeowner's claim, assignment of
  benefits, "sign … today", "free roof", "no cost to you" / "nothing out of pocket". Only when
  the owner never wrote it. Hit `insurance`, cap 0.2, in `REGENERATE_ON` (one fresh attempt),
  flag "Talks about the deductible or the insurance claim in a way you may not be allowed to
  promise. Check it." Any flag already keeps a draft out of autopilot and Send together (tested).
  `draft.v8` "Never invent" gains the deductible / claim / sign-today line.
- **Lead-paint and safety claims (Check 41 P1, wave 1):** `SAFETY_CLAIMS` in draft-checks.ts —
  "no lead worries" (no need to worry about lead, lead-free, no lead), "safe for people or
  pets" (safe / harmless / non-toxic within a sentence of kids, baby, pets, dogs, family…,
  either order), "pet and kid safe" (pet-safe, kid-friendly…), and on an older home only
  (`olderHome()`: a year 1800–1977 near built / house / home / colonial, or "old house",
  "pre-1978", "victorian") power sanding, sandblasting, torching, burning off, heat guns. Only
  when the owner never wrote it. Hit `safety`, cap 0.3, in `REGENERATE_ON`; flag "Says “…”.
  Safety and lead claims are yours to make, not the assistant's. Check it before sending."
  `draft.v8` "Never invent" gains the safe / non-toxic / lead line. Eval cases: nursery paint,
  1924 colonial exterior, lawn treatment with dogs, mice bait with a toddler.
- **Rule claims and rebate promises (Check 39 P4 + 37 P5, wave 1):** a draft sentence naming a
  program or rule word (rebate, incentive, tax credit / credit — not "credit card" — HEAT Loan,
  Mass Save, 0% loan, qualify, eligible, EPA, R-22, R-410A, R-454B, R-32, freon, refrigerant,
  banned, phased out, legal / illegal, no longer made / allowed, code requires) that the owner's
  own text (profile, price list, notes, instruction, their emails) never uses → hit
  `rule_claim`, "Says something about a rebate, tax credit or refrigerant rule. Check it's still
  true before sending.", cap 0.5, flag only (not in `REGENERATE_ON`, no extra model call). New
  soft promise "a rebate or utility will pay" (Eversource / National Grid / Unitil / Mass Save /
  the utility / rebates … covers / pays for / gives back / free / no cost; "you'll qualify for
  the rebate").
- **“That's covered” and overages (Check 38 P7, wave 1):** new soft promises (owner-text rule,
  usual "make sure you stand behind that" wording): "that's covered" (that's / it's / this is
  covered, "covered under warranty / labor"; not "covered with plastic" or "you're covered for
  Tuesday"), "fix it for free", "add it to the (final) bill / invoice / price", "that's fine"
  right before an amount or "over", "no extra charge / cost / fee".
- **Light payment-terms check (Check 23 P5, wave 1):** every ordinary reply now carries
  `termsSource` (payment terms + policies + price list, plus the owner's spoken words on a
  tweak) and `ownerWrote` (the owner's emails on the thread, a clean earlier draft). checkDraft
  flags a way to pay said the draft's way ("Venmo works", "by Zelle", "pay in cash"), deposit
  wording ("half down", "a deposit of", "30% up front") and credit terms ("net 30", "due in 15
  days", "pay later", "payment plan", "financing") that the owner's terms and emails don't say:
  "Mentions “net 30” — that isn't in your payment terms. Check it.", cap 0.5. **Adapted:** its
  hit is `payment_terms`, not `terms` as the prompt says, because `terms` is in `REGENERATE_ON`
  and the prompt says this one must flag without a rewrite. Off when a caller gives no
  `termsSource` (old callers unchanged). "Let me check" and "card" alone stay clean.
  (draft.v6's vocabulary line "T&M vs. fixed price, net 30" is Check 23 P11's, in the review's
  draft.v7 bundle — not done here.)
