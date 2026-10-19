# Notes from `w3-growth-site` (wave 3, Group 4: Growth site and form)

Base: faef9a5. No migration on this branch. No prompt files. Legal sentences are in
`docs/notes/legal-w3-growth-site.md` (never applied here).

## Step 1 (Check 3 P3): merge Facebook and Instagram ads — NOT built, Davi's call

Safe default kept: the seven service cards and seven form checkboxes stay as they are
(`google_ads`, `facebook_ads`, `instagram_ads`, `social_posts`, `google_business_profile`,
`reviews`, `website`). Later steps apply their wording to both ad cards.

**Proposal if Davi says "merge them":**

- `src/config/growth.ts`: relabel `facebook_ads` "Facebook and Instagram ads", one blurb ("Your
  finished work, shown to people in and around the towns you work in, on Facebook and Instagram.
  Built from your own photos, never stock pictures."), and remove the `instagram_ads` card.
- **Keep `instagram_ads` as a legacy id.** It is stored in `growth_clients.services` and
  `invites.growth_services` (and old `[Growth call]` blocks say "Instagram ads"). So: a
  `GROWTH_LEGACY_IDS = { instagram_ads: "facebook_ads" }` map; `isGrowthService` /
  `growthServicesFrom` / `growthServicesFromLabels` / the form action map the legacy id (and
  the "Instagram ads" label) to `facebook_ads` and de-duplicate, so a page loaded before the
  deploy and every stored row keep working. `GROWTH_OWNED` loses its `instagram_ads` key (the
  `Record<GrowthService,…>` type then forces nothing else). Do not migrate data (previews share
  the production database).
- Grid: six cards at `lg:grid-cols-3` leave no orphan, so step 13's two-column first card would
  go back to a plain three-column grid.
- Tests as in the spec (old "instagram_ads" post accepted and stored once; six checkboxes).

## Step 2 (Check 2 P4 + Check 3 P2): ad reach wording

Both ad blurbs now say "in and around the towns you work in"; a code comment names Meta's
Housing special ad category. New FAQ "Can my Facebook ads show only in my town?" (factual, from
Meta's rules — show Davi). The form's note hint "The towns you work in…" is about the
visitor's own towns, not ad reach, so it stays.

## Step 3 (Check 2 P1 + Check 3 P7): banned words

P1 items 1–4 were already done at the tip (every button is "Ask Davi to call me", "Sending…",
no "find a time"); only the bans were missing. Now banned in every Growth source file and the
rendered copy: "book a free call", "booking", "find a time", "first page", "page one", "#1",
"number one", "more leads", "google screened", "license verified", and whole-word "rank".
The current copy passes.

## Step 4 (Check 2 P2): confirmation email to the visitor

`sendGrowthConfirmation` / `sendGrowthEmails` in `src/server/growth.ts`; copy in
`growthCopy.confirm` (fixed words + `siteConfig.phone`, nothing typed). Resend key
`growth-confirm-<addressKey>-<New York date>`, Reply-To from `SUPPORT_EMAIL` when set, raced
against `GROWTH_NOTIFY_TIMEOUT_MS`; sent side by side with Davi's notice (`Promise.allSettled`);
logs `growth_notify_failed` / `growth_confirm_failed {error: name}` only. Not a Gmail send path
(Resend, like the waitlist confirmation). **Goes live with the Resend domain** (LAUNCH: verify
the domain, switch `EMAIL_FROM` off onboarding@resend.dev); until then `sendEmail` delivers only
to the Resend account's own address. docs/SETUP.md §7b says so. Privacy wording: legal note.

## Step 5 (Check 2 P3): the hidden trap field

Both public forms' trap input is now `sa_hp` ("Leave this empty"; `src/server/trap-rules.ts`,
pure). A page loaded before the deploy still posts `website`, so both names count. Trap + a form
that fails validation = today's polite success, nothing stored or counted. Trap + a valid form =
stored as usual with the line `Flag: hidden field filled` (`TRAP_FLAG`, `growth-note.ts`: last
line of the Growth block, or the last line of the waitlist app note), and **no email** to Davi or
the visitor. /admin's card shows "Might be a bot: the hidden field was filled". Logs only
`growth_trap_hit` / `waitlist_trap_hit {stored}`. `describeWaitlistEntry` returns `appFlagged` and
an `appNote` without the flag line (so an invite never carries it); a typed line that reads
exactly like the flag is stored as "(flag)".

CLAUDE.md line to change: the Growth section's "the hidden 'website' field for bots" → "the
hidden `sa_hp` trap field (Check 2 P3: filled + valid = stored with a flag, nobody emailed)".

## Step 7 (Check 3 P6 + Check 34 P4): two FAQs — HOLD for Davi's okay (commercial policy)

Built with draft answers; revert this one commit if Davi hasn't okayed them.

- Second in the list: "How is this different from a marketing agency?" — "You talk to the
  person doing the work, who runs a remodeling company too. There's no sales team and no
  hand-off. Your email is never part of it. You get a clear price before anything starts."
  (The spec's "and he runs…" was reworded: no pronouns for Davi.)
- After "What does it cost?": "Who pays for the ads?" — "You do, straight to Google or Facebook,
  from an ad account in your business's name. You set the monthly limit. Davi's fee for running
  them is separate, and you'll know it before any work starts."
- **Not added** (commercial terms, Davi's call): "Month to month, stop any time." and "Your
  Google listing, ad accounts and website stay in your name."

## Step 8 (Check 2 P6): room for real proof

`siteConfig.operatorPhoto` (null) feeds the homepage About section and /growth's "who does the
work" (null = exactly as before). `src/config/growth-proof.ts`: `GROWTH_PROOF = []`,
`liveProof` (valid dates, checked within 12 months). `growth-proof.tsx` renders "what it looks
like, for real." only for live items (https links only). The "testimonial" ban stays.
/growth is static, so a stale item disappears at the next deploy, not on the day.

**docs/LAUNCH.md, "Still needed from you":** add
"- **Growth proof:** a real photo of you (`siteConfig.operatorPhoto`, file in `public/brand/`),
and any client proof for /growth (`src/config/growth-proof.ts`). Each proof item needs the
client's written okay (the date goes in `permissionOn`) and a yearly check that it's still true
(`checkedOn`); nothing is shown without both."

## Step 9 (Check 2 P7 + Check 6 P6): ground rule and homepage hand-off copy

- Ground rule 1: "…your email is used only to run the app for you, like sorting, drafts and
  follow-ups, and never for Growth ads, posts or anything else outside the app."
- hero.link "Want more work coming in? We also run ads, your Google listing and reviews";
  bridge.heavy "Need more jobs? We'll do the marketing for you."; bridge.body names the four
  services and "never touches your inbox".
- The Big words switch now reads "Your inbox" → "Your marketing" (still aria-hidden). Its
  per-word font sizes were re-tuned in theme.css (from 20vw / min(20vw, 16vh), to 11.5vw /
  min(11.5vw, 14vh); measured in Chromium: both words about 86% of a 375px screen, 22px+ gutters
  at 320px) so the longer words still fit the band; the e2e "fits side to side" checks are
  unchanged. (Step 9's commit had a first guess; step 14's commit carries the measured values.)
- **CLAUDE.md:** the Growth "Big words" paragraph names "The app" / "One-on-one" — now
  "Your inbox" / "Your marketing" (Check 6 P6).

## Step 10 (Check 7 P7 + Check 6 P11): names keep their capitals in headlines

Rule written in `src/components/brand/headline.tsx`. Changed: Growth "ask Davi to call you.",
the portal's "call or text Davi.", Settings "your Gmail.", the access-lost email "reconnect
Gmail.", and customer pages ("Dana," — `headlineName` keeps names as written; no name is still
"this customer,"). `tests/unit/headlines.test.ts` scans every serif/heavy field under src.
Touches `src/components/growth-portal/portal-copy.ts`, `src/server/alerts.ts` and
`settings/gmail/page.tsx` (one line each) — possible small conflicts with App emails (alerts.ts).

## Step 11 (Check 2 P8 + 3 P4 + 5 P2 + 45 P5 + 44 P3): form fields — safe default, no migration

Davi picks the final field list. Built now, all **optional and additive**, as lines in the
`[Growth call]` block only (no columns; Group 5's `growth_requests` carries them):

- "Not sure yet — tell me what to do first" (`GROWTH_NOT_SURE`, last checkbox; services still
  need at least one, so P4 wins over P8's "services optional"). Not a card. The spec's label had
  a comma, which would split when a stored block is read back, so it's an em dash.
- "How did you hear about Davi? (optional)" (`GROWTH_HEARD_FROM`, the id is stored as
  `Heard from: <id>`) and, only with "Another contractor told me", "Who sent you? (optional)"
  (≤80, one line, scrubbed; `Sent by: <text>`; dropped server-side with any other answer).
- "Which state do you work in? (optional)" (`US_STATES`; `State: AZ`) and the browser's time zone
  (hidden `TimeZoneInput`; `Time zone: America/Phoenix`; an invalid zone is dropped).
- /admin card: "Works in AZ", "Their time now: 6:12am", "Heard: …", "Sent by: …".
- Logged: `growth_call_requested {existing, services, heardFrom: boolean}` only.

**Not built (Davi's call):** trade optional and services optional (C02 P8); town, and state/town
on the app waitlist form with `waitlist.state` / `waitlist.town` columns, the "Massachusetts
only" chip and MA-first sort (C44 P3, needs a migration — put them on `growth_requests` /
waitlist in one lane turn if wanted); "State: AZ" in Davi's email notice (C45 P5 item 5: the
notice is content-free today, and a body that changes under the same Resend idempotency key
gets a 409). Privacy lines: legal note.

## Step 12 (Check 33 P2): search words and structured data on /growth

Title "Contractor marketing, done for you · Squared Away Growth"; description "Google and
Facebook ads, Google Business Profile, reviews and websites for anyone in the trades, done
one-on-one by Davi Chaves, a Massachusetts remodeler." (≤160, built from siteConfig); eyebrow
"Squared Away Growth · marketing for contractors, run from Massachusetts" (the state from
`siteConfig.location`). `growthStructuredData` in `src/lib/structured-data.ts` (one Service, no
offers / ratings / areaServed) rendered on /growth; `src/lib/structured-data.ts` added to the
growth-boundary MENTIONS list with its reason. Expect a small overlap with the Google group's
step 11/12 if it also touches structured-data.ts or public-site e2e.

## Step 13 (Check 7 P4 + Check 7 P6 + Check 2 P9): share card, one mark, laptop layout

- `buildShareCardTree` (exported): each headline word is its own span in a wrapping flex row with
  a pixel column gap (Satori ignores `wordSpacing` and em gaps); checked by rendering the PNG:
  "the marketing side, / done for you." now has clear gaps. The homepage card is unchanged
  visually ("handled." is one word).
- `src/components/brand/growth-mark.tsx` (Wordmark + "growth" chip, one name "Squared Away
  Growth") on the homepage Growth bar (replacing the plain "Squared Away Growth" text; the unused
  `growthCopy.bar.label` is gone) and the /growth header. Call buttons `whitespace-nowrap`,
  `px-3` below sm.
- Services grid `sm:grid-cols-2 lg:grid-cols-4`, the first card spanning two columns: seven
  cards leave no lone card at sm or lg (if Davi merges the ad cards, step 1, six cards go back to
  three columns with no span). The "Text …" button is hidden from lg up.

## Step 14 (Check 29 P9): content-visibility for off-screen homepage sections

`.sa-cv` (theme.css: `content-visibility: auto` + `contain-intrinsic-size: auto <measured>`),
applied through `src/lib/deferred-section.ts` to How it works, Our promise, What it does,
Pricing, Questions (app half) and What we take on, You own everything, How Growth works, Ground
rules, Growth questions (Growth half, also on /growth). Not on the Introduction, About, the
waitlist, the bridge, the Growth opener (#growth), the call section (#growth-call), the sticky
header/bar or the switch stage. Sizes measured at 375px and 1280px. New e2e (mobile project):
three crossings under CDP 4x CPU throttling, worst requestAnimationFrame gap < 120ms.

## Step 15 (Check 26 P8): first and newest request — limit built, the rest is Davi's call

Built: a per-email limit on both public forms (`LIMITS.formEmail`, 5 a day, keyed by
`addressKey` — an HMAC, never the address), checked after validation; the 6th try reads "Too
many tries for this email today. Try again tomorrow, or call or text 978-201-9763."

**Not built (needs Davi's okay, privacy text):** keeping the first request as well as the newest
(`MAX_GROWTH_BLOCKS = 2`, "First request" / "Sent again" labels) and never replacing a stored
phone. Today CLAUDE.md and the privacy policy say "the newest request per email replaces the
last" and "a replaced request leaves no old number behind". Proposal: decide it on Group 5's
`growth_requests` table instead (one row per request, newest shown first, the stored phone never
overwritten), with the privacy sentence "If you send the form again, we keep your first request
and your newest one." (legal note, only if Davi says yes).

## Fixes from the full checks (after step 15)

- `.sa-cv` sizes are now the sections' **content** height (measured height minus padding and
  border): contain-intrinsic-size stands in for the content, so the padded sizes made the page
  jump as sections rendered and the switch e2e landed past its line.
- /growth's header hides "The app" below `sm` so the GrowthMark header fits at 320px (the page
  ends with "See the app").
- The CPU-throttled crossing e2e (Check 29 P9) is opt-in (`SA_PERF=1`): on this shared machine
  (load 10–20 on 4 CPUs) it read 250–350ms worst frames, which says nothing about phones.
  **Not verified** on an idle machine — run `SA_PERF=1 pnpm test:e2e tests/e2e/growth.spec.ts`
  before trusting the < 120ms claim.
