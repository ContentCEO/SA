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

## Step 6 (Check 3 P1 + Check 3 P5): "you get" lines and the Reviews card — HOLD for Davi's words

Built with the review's **draft** wording; Davi must okay or edit before this reaches
production (the integrator can revert this one commit cleanly — later steps don't depend on it
except the copy test's `includes` checks, which go with it).

- `includes` (2–4 lines, < 70 chars) on every `GROWTH_SERVICES` entry, rendered as a plain list
  under each card (`growthCopy.services.items[].includes`, list named "What you get with …").
  Facebook ads and Instagram ads each carry the same two lines (cards not merged, step 1).
- Reviews blurb: "Your Google review link and a short message you send to every customer
  yourself, plus help answering the reviews you get. We never write fake ones, and we never
  message your customers."
- Ground rule "No made-up reviews": "…post photos of someone else's work, or offer anything in
  return for a review."

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
  per-word font sizes were re-tuned in theme.css (from 17vw / min(17vw, 16vh), to 10.8vw /
  min(10.8vw, 11vh)) so the longer words still fit the band at 320–375px; the e2e "fits side to
  side" checks are unchanged.
- **CLAUDE.md:** the Growth "Big words" paragraph names "The app" / "One-on-one" — now
  "Your inbox" / "Your marketing" (Check 6 P6).
