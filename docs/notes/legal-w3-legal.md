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
