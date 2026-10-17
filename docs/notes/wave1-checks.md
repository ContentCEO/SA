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
