# Legal wording from branch `w3-legal` (wave 3, "Legal text, one release")

For the integrator's one legal release (`docs/LEGAL-RELEASE.md`). Nothing here is in
`docs/terms.md` or `docs/privacy-policy.md` yet; `TERMS_VERSION` is still `2026-10-16`. Every
sentence needs Davi's written okay (and the lawyer's where Davi wants it) before it goes in. Where
there is a choice, the recommended option is marked **(recommended)**.

## Check 50 P5: the rule itself (for `docs/BUILD-ORDER.md`)

Add this section to `docs/BUILD-ORDER.md`, after "Before you start a step":

> ## Legal text
>
> Builders never edit `docs/terms.md`, `docs/privacy-policy.md` or `TERMS_VERSION`. They write
> the exact wording they need in `docs/notes/legal-<branch>.md` with the reason and the review
> prompt id. `tests/unit/legal-freeze.test.ts` fails any other branch that changes them (branches
> named `claude/legal-*` and `integrate-*` are allowed). The integrator applies every note in one
> `claude/legal-<date>` release, so owners agree again once (`docs/LEGAL-RELEASE.md`).

## Check 27 P1: the three `[To confirm]` items in `docs/terms.md`

Still true at the tip: the banner (lines 1–2) and three `[To confirm]` lines (Plans and payment,
Limits on liability, Law); `tests/unit/legal-docs.test.ts` pins exactly three. Decisions are
Davi's, with the lawyer's wording where there is one. The texts below follow the options LAUNCH
step 13 recommends (option A for each), in plain words, ready to paste. Stripe's checkout
`custom_text` (`src/server/billing.ts`) carries only the "I agree" line, no refund words, so
there is nothing to mirror there unless Davi wants one.

### 1. Refunds (replaces the bullet "**[To confirm]** Whether the setup fee and the current month are refundable, and in which cases.")

**Option A (recommended):**

> - Refunds: a monthly plan can be cancelled at any time and stays on until the end of the month
>   you've paid for; we don't refund part of a month. The setup fee is refunded in full if you
>   cancel before your setup call, and not after it. **Delete my account** ends your plan at once,
>   with no refund for the rest of that month. If we stop the service, or close an account that
>   broke none of these terms, we refund the unused part of the month, and the setup fee if the
>   setup call hasn't happened.

**Option B:** the same, but no setup-fee refund at all ("The setup fee is not refundable.").

### 2. Limits on liability (replaces the paragraph starting "**[To confirm]** The limit of our liability …"; keep its last sentence)

**Option A (recommended):**

> To the extent the law allows, neither of us is liable to the other for more than the greater of
> one hundred dollars or the amount you paid us in the twelve months before the problem, and
> neither of us is liable for lost profits, lost jobs or other indirect losses. You approve every
> reply that goes out (autopilot only when you switched it on), so a reply's contents are your
> responsibility. This limit doesn't cover unpaid fees, fraud, harm done on purpose or gross
> negligence. Nothing in these terms limits liability that the law doesn't allow us to limit.

Note for the release: `tests/unit/legal-docs.test.ts` "names no price" fails on any `$` figure in
the terms, so the floor is written in words ("one hundred dollars"), or left out.

### 3. Law (replaces the paragraph "**[To confirm]** That these terms are governed by the laws of the Commonwealth of Massachusetts and where disputes are heard.")

**Option A (recommended):**

> These terms are governed by the laws of the Commonwealth of Massachusetts. If there's a
> dispute, contact us first and we'll try for 30 days to sort it out. After that, it goes to the
> state courts in Middlesex County, Massachusetts, or the federal court for the District of
> Massachusetts, and you agree to those courts. Either of us may use small claims court instead.

**Option B:** add binding arbitration (AAA) with a small-claims carve-out. LAUNCH step 13 notes the
filing costs; not recommended.

### The banner

Keep "> **Draft — not yet reviewed.** …" in both documents until a lawyer has reviewed them; then
delete the two banner lines from both. If the banner stays while the `[To confirm]` items go,
change its second sentence from "Items marked **[To confirm]** are business decisions that haven't
been made." to nothing (delete it): there are no such items left.

### Tests the release changes

- `legal-docs.test.ts` "keeps Davi's three [To confirm] items exactly" → "no [To confirm] remains"
  in either document (keep the "plus any taxes" and `TAX_BEHAVIOR` assertions).
- The render test's `**Draft — not yet reviewed.**` expectation, only if the banner goes.
- Both "_Last updated:_" lines and `TERMS_VERSION` → the release date (one bump for everything in
  this file).

## Check 27 P2 + Check 27 P7: data requests, and the promise to owners' customers

Built in code (no legal text): with `SUPPORT_EMAIL` unset the Contact block of both documents
ends with "Text: 978-201-9763 (texts get a written reply)" (an `sms:` link) instead of nothing,
so a data request always has a written channel; with it set, the "Email:" line as before. /admin's
System box says "No support email set. The privacy policy has no email for data requests." and
inverts in production. Davi's step: choose the support address and set `SUPPORT_EMAIL` in Vercel
(Production and Preview), then redeploy (LAUNCH step 5); the text line then stops showing.

### P7: the "Your choices" bullet in `docs/privacy-policy.md`

Still true at the tip: the bullet reads "To see, correct or delete what we hold about you —
including if you are a customer of one of our users — contact us below." and the product has no
per-sender deletion (deletion is per mailbox or per account). Replace that one bullet with two
**(recommended, the spec's wording)**:

> - To see, correct or delete what we hold about you as a Squared Away user, contact us below.
> - If you emailed a business that uses Squared Away, that business decides what happens to your
>   emails. Contact them first. If you contact us, we'll tell the business about your request
>   within 5 business days and help them carry it out.

Test for the release (`legal-docs.test.ts`): assert both sentences, and that "including if you
are a customer of one of our users" is gone.

### For `docs/LAUNCH.md` (not legal text; integrator-only file): "Requests from the public"

Add after step 5 ("Support email and the production domain"):

> ### Requests from the public
>
> Someone who emailed one of your owners may write to the support address (or text the business
> number) asking what Squared Away holds about them, or to have it corrected or deleted. The
> privacy policy promises to tell the owner within 5 business days and help. The steps:
>
> 1. Note the date you got the request and the sender's email address (nothing else).
> 2. Call the owner the same week. Tell them who asked and what for. The decision is theirs: it's
>    their business mail.
> 3. Never open the customer's emails yourself, in the app or in the database. /admin shows no
>    email content on purpose.
> 4. If the owner wants the emails gone: today the app deletes per Gmail address (Disconnect) or
>    per account (Delete my account); a single sender can't be removed on its own yet. Tell the
>    owner that plainly, and ask the engineers if a per-sender delete is wanted.
> 5. Reply to the person in writing with what was done, and keep the note of the date.

## Check 27 P3 + Check 27 P4: "What changed", and same-day versions

Built in code (no legal text): `docs/legal-changes.md` (one `## <version>` section per
`TERMS_VERSION`, newest first, entries for 2026-10-16 and 2026-10-15 written from the documents'
git history); `/welcome/terms` shows "What changed" with the bullets of every version newer than
the one the owner agreed to (someone who never agreed sees none); `TERMS_VERSION` may be
`YYYY-MM-DD.N` for a second release on one day (sorts between the date and the next day, in code
and in the database's `collate "C"`); `LEGAL_DOCS_SHA256` in `src/config/legal.ts` is the hash of
both documents and `tests/unit/legal-docs-hash.test.ts` fails with the new value when they change.

**Not done on purpose:** P4 item 3 ("set 2026-10-16.2 so owners who agreed to the earlier
same-day text are asked again") contradicts Davi's recorded choice (LAUNCH step 13: the
2026-10-16 clarifications re-asked nobody). The one release bumps to its date anyway, so `.2` is
only for a second legal release on the same day.

### P3 item 3: the advance-notice promise (Davi's choice)

Both documents promise notice **before** changes take effect (privacy policy "Changes": "for
significant changes, tell you in the app or by email before they take effect"; terms "Changes to
these terms": "tell you in the app or by email before significant changes take effect"). The code
does something else: a new version takes effect at deploy and the next screen asks everyone to
agree, now with "What changed".

- **Option (b) (recommended: it matches what the code does, and needs no second mechanism):**
  reword both sentences.
  - Privacy policy, "## Changes": replace the paragraph with
    > If we change this policy, we'll update the date at the top and, for significant changes,
    > show you what changed in the app before you keep using it.
  - Terms, "## Changes to these terms": replace the paragraph with
    > If we change these terms, we'll update the date at the top and, for significant changes,
    > show you what changed in the app before you keep using it.
- **Option (a):** keep "before they take effect"; then the engineers add `TERMS_NOTICE_FROM` to
  `src/config/legal.ts` and a StatusBanner line "Our terms change on <date>. See what changes."
  shown from that date until the version takes effect (not built; one more thing to set on every
  release).

For the release, with (b): `legal-docs.test.ts` asserts the new sentence in both documents.

### For the release (P4): the version and the hash

Set `TERMS_VERSION` to the release date; recompute `LEGAL_DOCS_SHA256` (the failing test prints
the value); add the `## <release date>` entry to `docs/legal-changes.md` (two to five plain
bullets: the three decided items, the data-request bullets, the Limited Use wording, the texting
section, and so on). `tests/unit/legal-changes.test.ts` fails until the entry exists.

## Check 27 P5 + Check 27 P8 + Check 45 P6: privacy-policy sentences

All wording; nothing in the policy changed. The one code half done now: `docs/google-verification.md`
(not integrator-only) already carries the Limited Use commitment below in Google's terms, so the
verification doc and the policy agree once the release applies this.

### P5: Limited Use, "In plain words" list

Replace the bullet "- We don't use Gmail data to train AI models, and our AI provider doesn't
either." with **(recommended, the spec's wording; Google's help page asks for these terms)**:

> - We don't use data we receive from Google Workspace APIs, including Gmail, whether raw,
>   combined, anonymized or derived from it, to develop, improve or train generalized or
>   non-personalized AI or machine-learning models, and our AI provider doesn't either. The
>   writing-style description we make from your sent mail is used only for your own drafts.

Test for the release: extend `legal-docs.test.ts` "uses Google's Limited Use template sentence…"
to also require "generalized or non-personalized AI or machine-learning models".

### P8: six small lines

1. "## Who this policy covers": "This policy covers the owners and staff who sign in" → "This
   policy covers the business owners who sign in" (one owner per workspace; staff can't sign in).
2. "**Cookies:**" paragraph, append after "Private customer notes are left out of that copy.":
   > Our public pages also remember, for that browser tab only, the campaign tags and the site you
   > came from, so a sign-up can say where it came from; closing the tab clears it.
   > (`src/lib/landing-source.ts` keeps them in the tab's session storage. The app also keeps, in
   > the tab only, what you typed in a draft's Edit box and which button you used, so a refresh
   > doesn't lose them; say so if Davi wants every detail: "and, in the signed-in app, what you've
   > typed in a draft's Edit box until you save it".)
3. Same paragraph, append:
   > Do Not Track: we don't track you across other sites, so we don't change anything when your
   > browser sends a Do Not Track signal.
   > (CalOPPA asks sites collecting personal information from California residents to say how they
   > respond to Do Not Track; for the lawyer to confirm.)
4. "**Anthropic**" bullet: "Anthropic may keep it for a limited time under its own policies, for
   example to prevent misuse." → "Anthropic deletes it within 30 days, unless it needs to keep it
   longer to stop misuse or the law requires it." **Fact to verify on the day of the release** on
   Anthropic's privacy center (some sources say 7 days since September 2025); write the number
   Anthropic states that day.
5. "## Security": Check 26 P5 (the failed-query log scrub) is **not** in BUILD-ORDER's Done list,
   so use the softened sentence: "Our logs never contain email text, access tokens or customers'
   personal details." → "We never write email text, access tokens or customers' personal details
   to our logs on purpose, and we remove them from error reports." (If Check 26 P5 ships first,
   keep the original sentence.)
6. The referral-fingerprint sentence: **skip**; it is kept in `docs/SETUP.md` §6d for the change
   that turns referrals on.

Tests for the release: `legal-docs.test.ts` assertions for "Do Not Track", "for that browser tab
only", "business owners who sign in", "within 30 days"; `tests/unit/legal-w3.test.ts` ("what the
browser keeps is in the policy") can then also require the tab sentence next to its
`sessionStorage` scan.

### Check 45 P6: the breach sentence, "## Security"

Replace "If a security breach exposes your information, we'll tell you as soon as we can and
without unreasonable delay, as Massachusetts law (Chapter 93H) requires, and we'll notify the
authorities that law names." with **(recommended, the spec's wording)**:

> If a security breach exposes your information, we'll tell you as soon as we can and without
> unreasonable delay, and we'll notify the authorities named by the breach notice law of your
> state, including Massachusetts law (Chapter 93H).

Tests for the release: `legal-docs.test.ts` "round 2 (TC)" pins "as Massachusetts law (Chapter
93H) requires" → change to the new sentence, and add that the Security section contains "your
state".
