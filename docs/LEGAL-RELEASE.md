# The legal release: how the terms and privacy policy change

The Terms of Service (`docs/terms.md`) and the Privacy Policy (`docs/privacy-policy.md`) are
Davi's. `TERMS_VERSION` in `src/config/legal.ts` is their "Last updated" date, and
`src/server/terms.ts` asks every owner to agree again whenever it moves past the version they
agreed to. Changed one prompt at a time, owners would be stopped by the agree screen again and
again, and the documents would carry several dates in a few weeks. So the legal text ships as
**one release**, and owners agree **once**.

## The rule for builders

Builders never edit `docs/terms.md`, `docs/privacy-policy.md` or `TERMS_VERSION`. A unit test
(`tests/unit/legal-freeze.test.ts`) fails any branch that does, unless its name starts with
`claude/legal-` (the release) or `integrate-` (the integrator's merge). The test diffs the branch
against where it left `claude/squared-away-mvp-ddxl7s`, so an older change already on the base
never trips it, and it skips with a message when git can't say (a detached checkout with no
`GITHUB_HEAD_REF`, or a shallow clone without the base branch).

Instead, a builder writes the exact wording in `docs/notes/legal-<branch>.md`:

- one heading per review prompt ("Check 27 P6"), with the reason;
- every sentence word for word, as it should appear in the document, and where it goes (the
  heading or the bullet it replaces or follows);
- when there is a choice, each option, with the recommended one marked;
- any place the code repeats the words (Stripe checkout text, `docs/google-verification.md`, a
  screen), so the mirror is updated in the same release;
- the test changes the release needs (which pinned sentence in `tests/unit/legal-docs.test.ts`
  moves, and to what).

Wording that lives outside the two documents (the connect screen, the texts screen, emails, the
launch checklist) isn't frozen: builders change it in their own branch.

## The release, step by step (the integrator)

1. **Collect** every `docs/notes/legal-*.md`. Branch `claude/legal-<date>` from the tip of
   `claude/squared-away-mvp-ddxl7s`.
2. **Apply** each sentence to the documents. Get Davi's written okay on every sentence (and the
   lawyer's where Davi wants it). Nothing goes in without it. Remove the "Draft — not yet
   reviewed" banner only if a lawyer has reviewed both documents.
3. **Set the version once:** both "_Last updated:_" lines and `TERMS_VERSION` to the release date,
   `YYYY-MM-DD`. Use the `.N` suffix (`YYYY-MM-DD.2`, Check 27 P4) only for a second legal release
   on the same day. Never re-date clarifications already shipped (Davi's 2026-10-16 choice:
   nobody was re-asked for those).
4. **Recompute `LEGAL_DOCS_SHA256`** in `src/config/legal.ts` (the hash test says the command),
   and add a `## <version>` entry to `docs/legal-changes.md` with two to five plain bullets: the
   re-agree screen shows them under "What changed" to everyone whose agreed version is older.
5. **Update the pinned tests:** `tests/unit/legal-docs.test.ts` (the `[To confirm]` count, the
   banner, the new sentences), `tests/unit/terms-agreement.test.ts` stays green, and the
   `legal-changes` test wants an entry for the new version.
6. **Mirror** where the code repeats legal words: Stripe checkout `custom_text` in
   `src/server/billing.ts` (refunds), `docs/google-verification.md` (the Limited Use bullets),
   `src/app/sitemap.ts` (the date part), `docs/LAUNCH.md` step 13 (the decisions become
   decided).
7. **Delete the notes** and merge once. Every owner is asked to agree exactly once, on their first
   signed-in screen after the deploy, and sees what changed.
8. **Timing:** land it before Google verification is submitted (the reviewer reads `/privacy`) and
   before the first paying customer. Everything else can merge before or after it without touching
   the version.
