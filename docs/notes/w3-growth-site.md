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
