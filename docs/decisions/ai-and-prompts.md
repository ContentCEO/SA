# AI and prompts: models, classification, voice, prompt versions, evals and guards

Moved unchanged from `CLAUDE.md`'s "Decisions" section on 2026-10-19 (Check 49 P5), in their
original order. Rules that a test or gate depends on are also stated in `CLAUDE.md`.

- Haiku ID: using dated snapshot `claude-haiku-4-5-20251001` (as specified; alias is
  `claude-haiku-4-5`). Sonnet: `claude-sonnet-5`. Verified 2026-09-28 — unchanged from the brief.
- **Classification (M3):** prompt in `src/ai/prompts/classify.v1.ts` (versioned; new file per change),
  Haiku via `messages.parse` + `zodOutputFormat`, re-validated with Zod; one retry, then
  `unreadable` → needs_owner "Couldn't sort this one automatically". `applyOwnerRules`
  (`src/ai/classify.ts`) enforces complaint / legal / refund-dispute / VIP / amount > threshold /
  first-time sender + large job / confidence < 0.6 in code regardless of model output.
- Only the newest unclassified inbound message per inbox thread (last 14 days) goes to the model;
  older ones are marked superseded. Gmail Promotions/Social tabs → noise without a model call.
- Amount threshold defaults to $2,500 and VIP list is empty until the business profile (M4).
- "First-time sender" = no earlier message from that address in what we've synced (30 days).
- `src/ai/client.ts` `callStructured`: reserves a call against the per-workspace daily cap
  (`AI_DAILY_CALL_CAP`, atomic upsert; `ai_cap_80_percent` warning once/day), records tokens +
  estimated cost in `usage` (per UTC day, cost in centicents), logs only metadata. Tests swap the
  transport with `setModelTransportForTests`.
- Prompt caching: cache breakpoint after instructions + business block. Haiku 4.5 needs a 4,096-token
  prefix to cache, which the classifier prompt doesn't reach yet — it matters for Sonnet drafting
  (1,024 minimum), not here.
- `threads.needs_owner_manual`: the owner's "This one needs me" always wins over classification.
- **Profiles (M4):** `business_profile` (one row per workspace; business name + trade live on
  `workspaces`) and `voice_profile`. Form validation in `src/server/profile.ts` (plain-language Zod
  messages; list fields are one-per-line, trimmed, de-duped; VIPs must be emails, lowercased).
  Classification now reads the owner's threshold and VIP list.
- Voice learning (`src/server/voice.ts`, prompt `voice.v1`, Sonnet): up to 200 `in:sent` emails from
  the last year, quoted text stripped, 1.5k chars each / 150k total, held in memory only — never stored.
  <5 usable emails → `not_enough_mail` with no model call. Examples are model-written samples with
  placeholders, re-scrubbed in code (emails, phones, prices, street addresses).
- Owner edits set `source = edited`; the weekly refresh (Mon cron) skips those. "Re-learn from my sent
  mail" in Settings forces a re-learn and overwrites edits (explicit owner action).
- Voice learning reads sent mail 3 at a time (8 tripped Gmail's limit live and the learn died at
  "learning"). Retries 6; `workspace-lifecycle` (15 min) restarts voice for read mailboxes with no
  profile or stuck in "learning" > 30 min (`workspacesNeedingVoice`).
- **#48 More trades (2026-10-09):** one list in `src/config/trades.ts` (enum, forms, invite, admin).
  Per-trade `src/ai/prompts/trades/<trade>.ts` (vocabulary + quote questions; `Record<Trade, …>` makes
  a missing file a compile error, and a test checks the files). `draft.v3` puts the owner's trade
  words and "Before quoting, find out" into the cached business block; `followup.v2` / `voice.v2`
  only widen the trade wording. Enum values added with `ALTER TYPE … ADD VALUE` (additive).
- **classify.v2 (2026-10-09, plan #17 #27 #42):** schema adds `signals.from_building_department`,
  `signals.tries_to_instruct_assistant`, `extracted.permit` (issuing body, number, inspection time,
  passed/failed/scheduled/other, corrections) and `extracted.invoice` (number, amount, due date,
  unpaid/paid/partly_paid/unknown). Code-side guards in `src/ai/guards.ts`: `injectionCheck`
  (rules: instruction phrases, base64 runs, ≥3 zero-width/bidi chars — tuned so "ignore my previous
  email" / "send me the invoice" pass) runs **before** the model; injection (rules OR model) →
  needs_owner with `INJECTION_REASON` (overrides the model's reason). `looksMunicipal` (.gov,
  ci./town./co.*.xx.us, townof…, sender names like "Building Dept") OR the model signal → never
  noise (→ scheduling if an inspection is scheduled, else customer_question), never `low`, skips the
  Promotions shortcut. Both stored as `extracted.injection` / `extracted.municipal`;
  `createDraftForThread` skips them for every trigger except the owner's tap, and autopilot
  guardrails refuse both. `untrusted()` (`src/ai/prompts/untrusted.ts`) stops email text closing
  its `<email>` / `<conversation>` block. Inbox shows a permit card and invoice facts. No separate
  Haiku call for injection: the classifier (Haiku) already returns the signal.
- **#46 Prompt evals (2026-10-09):** `tests/evals/cases.ts` (66 invented emails, every category and
  trade, injection + building-department cases, draft rules), `run.ts` (real `classifyEmail` +
  `draft.v3` + `checkDraft` on in-memory PGlite), `score.ts` (accuracy, needs-owner recall,
  injection recall/false alarms, permit/invoice facts, draft pass rate; `regressions()` allows 0.03
  wobble, **none** on needs-owner and injection recall). `pnpm eval` (tsx with
  `--conditions=react-server` so `server-only` loads) / `--update-baseline` / `--no-drafts`;
  GitHub Actions "Prompt evals" is workflow_dispatch only (needs the `ANTHROPIC_API_KEY` repo
  secret). `tests/evals/baseline.json` is empty until the first live run. Unit test runs the whole
  set through a stand-in model. **Extend the set whenever a prompt changes.**
- **Leads package (2026-10-16, branch `leads-build`; plan `ideas-plan-leads.md`: B4 B5-lane B3
  B2 B6 B14 B9 G5):** migration 0032 `leads` (additive: `threads.lead_channel`,
  `complaint_fixed_at`, `complaint_checkin_done_at`; `business_profile.service_towns`). **No prompt change** (classify.v4 untouched; the eval
  baseline is still empty): the town is read in code from the address the classifier already
  extracts, emergencies use its existing `urgency`, lead-site names come from labelled lines.
  - **Where a lead came from** (`src/server/channel-rules.ts`, pure; `src/config/phone-services.ts`):
    `channelOf(from)` = `phone` (Google Voice `voice-noreply@google.com`, exact), `phone_text`
    (email-to-text gateways, carriers' own published domains) or `site` (via `leadPlatformOf`,
    so platform matching never disagrees with the monthly label / Reply-To rules). Every
    `LEAD_SOURCES` entry has `site` (Facebook `null`; Google Local Services included, exact
    hosts only); "Open <site>" is a **fixed** https URL whose host must be on `OPEN_SITE_HOSTS`
    (`openSiteUrl`; tested) — never a link read from an email. Stored at classification as
    `threads.lead_channel` (never cleared by a later email). Promotions/Social shortcut bypassed
    for phone channels only. Customers leaves lead-channel threads out.
  - **Never drafted, never sent:** `createDraftForThread` refuses `lead_site` / `phone_message`
    first (every trigger, before the Reply-To read or any model call), then on the final `to`
    `text_address` (any gateway, every trigger; also a form whose Reply-To is a gateway) and
    `lead_site` by address (older threads); a phone-number-shaped address the owner never wrote
    to → jobs skip (`maybe_text_address`), the owner's tap gets `MAYBE_TEXT_FLAG` first.
    `queueSend` → `text_address` (403 on the API, `?error=textaddr`); `sendDraft` closes such a
    draft as discarded with **no Gmail call**; `reconcileDrafts` first expires pending drafts to a
    gateway or a lead-site robot (and their Gmail drafts); autopilot refuses lead channels and
    phone-like addresses. Precedence: lead-site/phone refusals before the no-reply rule.
  - **Owner rules** (`applyOwnerRules`): every hit stored as content-free keys in
    `extracted.owner_rule_hits` (`OWNER_RULE_KEYS`); new hits `emergency` (model urgency
    `emergency` + `LEAD_CATEGORIES` → needs you, priority high: emergencies are no longer
    auto-drafted), `phone`, `site`, `outside_area`. When any of those four hit, the stored reason
    is our fixed text (never the model's prose, which could carry a town or name past the purge).
    Cards read flags, never reason strings.
  - **Done** = the existing "I called them" (`handled_offline_at`, round 2 E11), relabelled "Done —
    I answered" / "Done — I called back" on lead cards (`?done=done`); no `owner_done_at` column.
    It already answers leads at risk, Not answered yet, Quotes and follow-ups via `lastOutSql`.
  - **Queue** (`queueMembership`, shared by digest / badge / push / screen): `lane` (B5, sorted
    first; injection never) and G5 check-ins (`checkIn`: fixed 2–30 days ago, not closed since, no
    customer email and no owner email / app reply since, no draft pending; never an emergency)
    join needs-you, content-free. The screen renders
    `NeedsYouCard` (`queue/needs-you-card.tsx`) with `leadCardsFor` (`src/server/lead-cards.ts`:
    a fixed number of queries per render): Call / Text (`ContactButtons`, plain `tel:` /
    `sms:?&body=`; numbers from `src/lib/phone-numbers.ts` + `contact-rules.ts`, code only:
    toll-free / N11 / 555-01xx refused, the owner's signature / alert phone / sent-mail tails
    skipped, machine mail needs a field label like "Phone:", a voicemail's subject names the
    caller; nothing stored or logged), emergency section with Call now first, voicemail cards
    (Call back, no Draft a reply, "Open in Gmail (to play it)"), lead-site cards (Open <site>,
    name / service / town parsed from labelled lines only, `lead-site-rules.ts`), complaint
    cards (Call first, **Mark fixed** → `?done=fixed`, refused with a pending draft
    `has_draft` or a legal hit), check-ins (All good), repeat-customer line (B14,
    `repeat-customer-rules.ts`: won > quoted (amount or a real owner email) > asked; lead
    channels and no-reply skipped; no price) and the towns line (B9).
  - **Not answered yet (B6)** (`never-answered.ts`): over 24 h and under 14 days, one row per
    customer (`row_number() over (partition by waitingReplySql())`, address never selected), no
    queue card, active mailbox synced < 30 min; lead channels, no-reply, injection, municipal,
    job done and decided quotes left out; the morning email adds a count-only line (excluding
    queue cards and leads at risk).
  - **Towns (B9):** "Towns you work in" under "Where do you work?" (pre-filled from it while the
    list is empty; saved only on Save), de-duped by `normalizeTown`. `townFromAddress` only reads
    "…, Town, ST [zip]" / "…, Town" (no digits, not a street). "Add <town> to my towns" takes the
    town from the stored address (never the form) and clears needs-you only when
    `owner_rule_hits` is exactly `["outside_area"]`.
  - Scorecard response time and `guessNoAnswers` leave lead-channel threads out. Inbox swaps
    Draft a reply for Open <site> (or a plain line) on lead-channel threads.
  - Privacy policy lines added (lead source / rule-hit / done / fixed marks; towns; Call / Text
    reads the number at render and never stores it; never draft/send to lead sites, voicemails or
    gateways); the documents were already dated 2026-10-16 = `TERMS_VERSION`, so no date move.
  - **Not built (deviations):** classify.v5 (customer name / town from the model, strict
    emergency wording) — waits for the eval baseline; purpose.v2 notes (polite no, calm
    complaint reply, check-in note) — the owner's ordinary "Draft a reply" covers them for now, so
    no `declined_at`; held B5 part 2 (emergency alerts) and its columns; RingCentral /
    Grasshopper / OpenPhone senders (need samples).
- **Where email text may go (Check 48 P7, 2026-10-17):** only to Anthropic, as one synchronous
  `messages.parse` per task (`src/ai/client.ts`), as the privacy policy says. No Message Batches or
  Files API until `ALLOWED_DATA_PATHS` (`src/config/models.ts`) turns one on with a policy update
  and a `TERMS_VERSION` bump; no "Covered Model" (30-day retention); `fetch` only to hosts tied to
  a privacy-policy line; no other AI SDK. `tests/unit/data-paths.test.ts` enforces it.
- **Prompt versions (Check 50 P2, `src/ai/prompts/registry.ts`):** a new version is a new
  `<kind>.v<N>.ts` file (constant `<KIND>_PROMPT_VERSION = "<kind>.v<N>"`) plus one line in
  `ACTIVE`; `prompt-versions.test.ts` fails on two files with one version, a gap, an `ACTIVE`
  that isn't the newest file, or code that records a version imported from an older file.
  Active after wave 3 merge A (2026-10-19): classify.v6, draft.v9, followup.v5, voice.v4,
  voice-examples.v1, revise.v2, purpose.v2, edit-tone.v1, opening-tweaks.v1, dispute-caution.v1
  (a suffix on draft / revise versions, never stored alone). The review bundles below landed in
  classify.v6 / draft.v9 / followup.v5 / voice.v4 (see "Wave 3 merge A"); the next free numbers
  are classify.v7, draft.v10, followup.v6, voice.v5. Taken, so the review pages' names shift:
  - **draft.v8** = the review's "draft.v7" bundle: Check 23 P11 + 43 P1 + 44 P1 (and 45 P2) + the
    prompt parts of 40 P1 and 41 P1. Then the trade files of Check 36 P8, 37 P4 and 39 P6, in
    draft.v8 or the next version (**draft.v9**).
  - **classify.v5** = Check 12 P2 + 12 P3 + 22 P9 + 38 P5 + 45 P7, plus the classify parts of
    21 P1, 21 P2, 22 P4, 37 P3 and 39 P5.
  - **followup.v5** = Check 12 P7 + 21 P7. **voice.v3** = Check 24 P5 + 24 P9.
  - Any later purpose prompt starts at **purpose.v3**; any change to the "Other ways to reply"
    asks is **opening-tweaks.v2**.
- **Voice (wave 2, `w2-voice`):**
  - **What's stored vs. how the last learn went (Check 24 P1 + Check 29 P2):**
    `voice_profile.last_attempt` (learning | ready | not_enough_mail | failed | capped |
    reconnect_needed) + `last_attempt_at` record every learn; `status` only becomes "ready" on
    success, and a row that already holds a voice (summary, greeting, sign-off or examples) stays
    "ready" whatever an attempt says (decided in SQL in `recordAttempt`). `workspaceContext` uses
    the voice whenever the row has content (`hasVoiceContent`, `src/server/voice-rules.ts`).
    Settings → Your voice: "The last update didn't finish (Oct 13). We're still using this voice."
    Stuck = `last_attempt` (else legacy `status`) "learning" for 30+ minutes.
    `voice_profile.restart_count`: the 15-minute backstop (`restartVoiceLearns`) counts restarts
    of a stuck learn; at 2 it stops, records "failed" and emails ADMIN_EMAIL once per workspace
    per day ("Voice learning failed twice for this account"; marker
    `voice_failed_alert:<ws>:<day>`, purged daily by `purge-voice-alert-markers`). Reset on a
    successful learn and on "Re-learn from my sent mail". An unexpected error after "learning"
    records "failed" and rethrows.
  - **Only the owner's own words (Check 24 P2):** `ownWords` / `splitOwnWords`
    (`src/server/voice-text.ts`, pure) cut quoted replies (multi-language "On … wrote" headers,
    also wrapped), forwards, Outlook blocks, ">" lines, phone/app footers and signature blocks.
    Any email with one word left counts; a forward with under 5 own words is skipped.
    `console.info("voice_learn", …)` logs the outcome and counts only (emails read, forwards and
    app-sent replies skipped). Classification's `prepareBody` is unchanged.
  - **Skips the app's own replies (Check 24 P3):** sent-folder ids matching
    `drafts.sent_gmail_message_id` with status `sent` are dropped; `edited_and_sent` stay.
  - **Scrub (Check 24 P4):** `src/server/scrub.ts` (pure) — named `SCRUB_RULES` (emails, spelled
    emails, phones incl. wa.me / tel:, prices in many forms, PO boxes, streets incl. Spanish /
    Portuguese order, units, ZIP after a state, Canadian postal codes). Invoice / permit / model
    numbers stay; the business's own phone and website (read from `business_profile.signature`)
    stay. Every stored field is scrubbed; owner-typed edits are not.
  - **Voice inbox (Check 24 P6):** `voiceMailbox()` picks among running mailboxes the owner's
    sign-in address, else the oldest by `created_at`. `voice_profile.learned_from_mailbox_id` (no
    foreign key: the voice stays when that Gmail is disconnected) → "Learned from mike@shop.com".
  - **Accepted ideas don't stop the weekly refresh (Check 24 P7):** `decideSuggestion` no longer
    sets `source = edited`; `ideaChanges` (`edit-learning-rules.ts`) applies the change and
    `learnVoice` re-applies every accepted idea oldest first after building its values.
  - **Stale samples (Check 24 P8, adapted):** `voice_profile.examples_stale` is set when greeting,
    sign-off, formality or length change (owner save or accepted idea) and by a learn whose
    re-applied ideas moved length or formality; while stale, drafts get `examples: []` and
    Settings hides the samples. Writing new ones (`voice-examples.v1` + job) waits for the Prompt
    versions group (`docs/notes/prompt-versions-inbox.md`).
  - **Failed first learn retried (Check 24 P12):** `voice_profile.retry_day` /
    `retries_that_day`: the backstop restarts a failed / capped first learn (no stored voice) after
    1 hour, at most 3 times a UTC day. A failed refresh of a stored voice waits for the weekly run.
- **Town, utility and job-kind lists (wave 2, `w2-lists`; Checks 22 P8, 36 P4 P5 P9, 37 P2 P3 P6 P7, 38 P8, 39 P7, 40 P5 P7, 41 P8, 44 P4, 45 P3):**
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
  - `looksLikeUtility(from, name)` (`src/ai/guards.ts`): eversource.com, nationalgrid.com,
    nationalgridus.com, unitil.com (and subdomains); a big utility's NAME counts only from those
    domains; a light plant's name ("Light Department", "Light Plant", "Electric Light",
    "Light & Power", "Municipal Light") from any domain but public webmail. Checked before the town
    check, so a light plant on .gov is the electric company. Stored as `extracted.utility`: skips
    the Promotions shortcut, never junk (noise → scheduling with a date, else customer_question),
    never drafted by a job (`skipped: utility`; the owner's tap still drafts), autopilot refuses
    ("The electric company always waits for you."), batch send treats it as untrusted. With a date:
    needs you, "From the electric company about a job date. Check it with your crew and the
    customer." (owner-rule key `utility`, fixed text).
  - `looksLikeUtilityScam(text, from, name)`: a big utility's name from another domain
    that wants payment, or anyone threatening a shutoff within hours/today and naming a gift card,
    prepaid card, Green Dot, MoneyPak, Vanilla, Reloadit, Bitcoin/crypto, Zelle, Cash App or Venmo.
    Sets `payment_change` (so every payment-change stop applies) and `utility_scam` (sticky for the
    thread), needs you, high: "Says it's from the electric company and wants payment now. Don't pay
    from this email; call the number on your bill." Owner-rule keys `utility_scam` + `payment_change`.
    Also caught past the AI limit (code-only result).
  - Known edge: rule (b) has no sender check, so a customer writing "we'll shut off the power today,
    I'll pay you by Venmo" is flagged as a scam (needs you, no job draft). Safe direction.
  - every town email (code or the model's signal) that isn't junk needs the owner, with a
    fixed line from its permit facts only (`municipalReason` in `src/ai/classify.ts`): "From the
    town: inspection failed, N things to fix." / "… inspection scheduled." / "… inspection passed."
    (priority normal) / "From the town." Owner-rule key `municipal` (fixed text: the model's words
    never ride along). Injection, gas, CO, electrical, payment change and the utility scam still win.
    Only the owner's tap drafts to the town, as before. The owner rules now read the kind the
    email ends up with (a town or utility email the model called junk is re-sorted first).
  - permit facts carry across emails on a thread (`carryPermitFacts`,
    `src/server/permit-rules.ts`): same permit (number, or same issuing body when a number is
    missing) keeps the fix list until it passes; new corrections replace it; a different permit
    replaces everything; an attack email never changes it. Retention purge unchanged.
  - The permit card (and the town caution) shows on the Queue's Needs-you card and draft cards; the
    folded Inbox row says "Permit E-26-0412 · 3 things to fix". The Failed badge now uses
    `bg-primary text-primary-foreground` so it stays inverted on a charcoal card too.
  - Eval cases with `municipal: true` now expect `needsOwner: true`.
  - new fixed labels in `src/config/job-kinds.ts` (only new threads; stored labels are
    never rewritten): plumbing Frozen pipes / Sump and ejector pumps / Backflow tests / Boilers and
    heating / Wells and water treatment / Valves and tanks / Home sale repairs (before Leaks);
    electrical Solar and batteries (first) / Smoke and CO detectors, and EV chargers lost the bare
    "charger" and "tesla" (added "wall connector", "tesla charger", "wall charger", "ev", "electric
    car", "electric vehicle", "charging"); remodeling Callbacks and touch-ups (first), Basements and
    Additions before Kitchens and Bathrooms, mudroom under Additions; hvac reordered (Water heaters,
    Maintenance and tune-ups, AC and heat pumps, Furnaces and boilers + heat/heater/oil
    burner/baseboard, Ductwork, Thermostats, Air quality and humidity, Commercial service, Repairs;
    "cleaning" dropped from tune-ups); roofing Metal roofs / Ice dams / Roof snow removal / Siding /
    Ventilation / Roof certifications in the review's order; landscaping Fences, Cleanups before
    Lawn care, Lawn treatments (fertilizer moved there), overseed/dethatch/core aeration under Lawn
    care; painting Power washing (before Exterior) and Floors.
  - Adapted: "wall charger" added to EV chargers so the existing monthly-summary case "Tesla wall
    charger" stays an EV job after "charger" and "tesla" left; "t&p" is stored as "t p" (keywords
    are stored normalized; a test enforces it), "touch-up" is covered by "touch up".
  - Known overlap: carpentry also has "Fences and gates"; landscaping's new kind is "Fences" as
    the review asked. A shop with both trades files a fence under its main trade's label.
- **Model keep-until dates (Check 48 P2, 2026-10-19):** `modelLifecycle` in
  `src/config/models.ts` (notBefore from Anthropic's model deprecations page, checkedOn, source;
  read 2026-10-19: Haiku 4.5 snapshot "not sooner than" 2026-10-15, Sonnet 5 2027-06-30, Haiku 5.5
  2027-10-07, Sonnet 5.5 2027-09-28). `tests/unit/model-lifecycle.test.ts` fails when a date is
  within 30 days or past and checkedOn is over 14 days old. `modelCapabilities` (effort allowed,
  thinking "omit" | "disabled") decides what `callStructured` sends (`requestOptionsFor`); Haiku
  5.5 trials send thinking disabled. `pnpm eval --model classify=<id>` (draft= / voice=) swaps a
  role's model through `setEvalModelOverrides` (eval script and tests only), ids only from
  `EVAL_MODEL_IDS`; `--update-baseline` refused with it. Production models unchanged. Checklist:
  docs/SETUP.md "When Anthropic emails about a model".
