# Notes from `w3-google` (wave 3, "Google review and the domain")

For the integrator. Everything below is text for files only the integrator edits (`CLAUDE.md`,
`docs/LAUNCH.md`), plus the questions for Davi. Steps are numbered as in `docs/BUILD-ORDER.md`.
Text in a fenced block is meant to be pasted word for word.

## Step 1: Check 28 P1 (LAUNCH.md text; SETUP.md §8 and google-verification.md were edited on the branch)

**LAUNCH.md step 2.** Replace the whole block that starts
`**A separate Google client for previews (optional).**` (through its "Worked when" line) with:

```
**A separate Google project for previews and local testing.** Google's verification checks every
address on the production OAuth client, and each must be on a domain you own and have proved in
Search Console (step 0a). A `vercel.app` address sits on Vercel's DNS and can't be proved, and
`localhost` can't either, so previews and local work get their own Google project, which is never
submitted. Neither makes it safe to connect a real Gmail address on a preview (see above).

1. console.cloud.google.com → the project picker → **New project** → name it `sa preview` →
   Create. Then, in that project: APIs & Services → Library → **Gmail API** → Enable.
2. Google Auth Platform (in the `sa preview` project) → Get started → app name `Squared Away
   (preview)`, your support email, External, your contact email → Create. Leave the publishing
   status at **Testing**: this project stays in Testing forever and is never submitted for
   verification.
3. Audience → **Add users** → the test Gmail addresses you use on previews (never your own or a
   customer's). These test users don't use places in the production project's 100-user cap: the
   cap counts per project.
4. Clients → **Create client** → Web application, name `sa preview` → Authorized redirect URIs:
   `https://<branch address>/api/auth/callback/google` and
   `https://<branch address>/api/gmail/callback` for each preview branch address you use (the
   addresses are explained above), plus `http://localhost:3000/api/auth/callback/google` and
   `http://localhost:3000/api/gmail/callback` for the engineers' computers → Create.
5. Copy its Client ID and Client secret, then split `AUTH_GOOGLE_ID` and `AUTH_GOOGLE_SECRET`
   (all three steps of "How to split a setting", including its **Cancel** rule) with those as the
   Preview values → Redeploy the preview. Or ask the engineers to untick Preview on both entries
   through Vercel's API first; then you only do step 5 of the split.

Worked when: signing in and Connect Gmail (with a test Gmail address) work on the preview's branch
address, Google's consent screen there says `Squared Away (preview)`, and both still work on
production. After this, the production client is cleaned of every `vercel.app` and `localhost`
address in step 0e ("Clean the live client"), once the old address forwards to your domain
(step 5, item 9).
```

**LAUNCH.md step 0e.** Add this first sub-step, before the Data Access bullet:

```
- **Clean the live client** (only after step 5, item 9: the old address already forwards to your
  domain). Where: Google Auth Platform → **Clients** → the web client. Authorized redirect URIs
  must list only `https://<your domain>/api/auth/callback/google` and
  `https://<your domain>/api/gmail/callback`; Authorized JavaScript origins must list only
  `https://<your domain>` (no `vercel.app` address, no `localhost`; delete the others). Then
  Branding → Authorized domains lists only your domain. Google checks every address on the client
  against domains you have proved, and `sa-dac3.vercel.app` can't be proved. The production
  project keeps exactly one OAuth client; previews and local testing use the `sa preview` project
  (step 2). Worked when: both lists show only your domain, and sign-in and Connect Gmail still
  work on your domain.
```

**LAUNCH.md step 5, item 3.** `Keep the old sa-dac3.vercel.app ones for now` is still right there;
add after it: `(they come off in step 0e, "Clean the live client", once item 9 forwards the old
address)`.

**Assertions for `tests/unit/launch-doc.test.ts` (or `verification-doc.test.ts`) once the note is
folded in:**

```ts
it("Check 28 P1: previews have their own Google project; the live client is cleaned before submitting", () => {
  expect(launch).not.toContain("A separate Google client for previews (optional)");
  expect(launch).toContain("**A separate Google project for previews and local testing.**");
  const step0e = sections0().slice(sections0().indexOf("**0e."), sections0().indexOf("**0f."));
  expect(step0e).toContain("**Clean the live client**");
  expect(step0e).toContain("`https://<your domain>/api/auth/callback/google`");
  expect(step0e).toContain("`https://<your domain>/api/gmail/callback`");
});
```
