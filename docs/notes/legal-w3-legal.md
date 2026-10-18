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
