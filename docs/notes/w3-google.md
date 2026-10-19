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

## Step 2: Check 33 P1 (LAUNCH.md text; the code is `src/config/host-redirects.ts`)

Built but off: `legacyHostRedirects()` returns `[]` until `VERCEL_ENV` is `production` **and**
`APP_URL` is an https address that is not on `vercel.app`. Davi turns it on by doing step 5 item 4
(APP_URL = the domain, redeploy); nothing else. `/api/*` and `/_next/*` never forward.

**LAUNCH.md step 5, item 9.** Replace the item (from `Once the new domain passes the smoke test`
through `lands on https://<your domain>/queue.`) with:

```
9. Nothing to click: once `APP_URL` is your domain and you redeploy (item 4), every `vercel.app`
   address forwards its pages to your domain by itself (`src/config/host-redirects.ts`), including
   `sa-flax-eight.vercel.app`, the project address Vercel serves without noindex, which would
   otherwise stay a second copy of the site. API addresses (`/api/…`) stay where they are until
   items 5 to 7 are done, so Stripe, Inngest and Gmail keep working during the move. After item 4,
   Connect Gmail only works when started on the new domain (Google sends the owner back there), so
   the forward also stops the old address being a second way in. Worked when:
   `https://sa-dac3.vercel.app/queue` and `https://sa-flax-eight.vercel.app/growth` both land on
   the same path on your domain.
```

**LAUNCH.md step 5, item 1.** Add one sentence after `Worked when: Vercel shows **Valid
Configuration**.`:

```
When you add the domain in Vercel → Domains, leave it as a Production domain (no Git branch).
Production domains in that list are the ones Vercel serves without noindex; `sa-dac3.vercel.app`
is a team address that isn't in that list, which is most likely why it carries noindex today.
```

## Step 3: Check 28 P2 (LAUNCH.md text only; google-verification.md was edited on the branch)

**LAUNCH.md step 0b.** After the "Paste:" bullet (the three links), add:

```
- Then verify the brand: on the same Branding page tap **Verify Branding**. If the status says
  **Ready to publish**, tap **Publish branding** within 7 days (after 7 days the check has to be
  run again). If Google asks for a manual review instead, wait (usually 2–3 business days) and
  answer any email from Google. Until the branding is published, Google's consent screen shows
  your domain where the app name should be.
- Worked when: Branding shows the branding as published (verified), and Google's consent screen
  (start Connect Gmail on your domain, stop at Google's permissions screen, then go back) shows
  "Squared Away" at the top instead of the domain.
```

Keep the existing "Worked when: Branding saves with no red warning …" line as the first check.

**LAUNCH.md order list** (the bullets under "Two of them can start now; the rest wait for the
merge"): change the second bullet to

```
- **After [step 1](#1-merge-the-launch-branch) (merge) and [step 5](#5-support-email-and-the-production-domain) (domain):**
  0b (all of it, including Verify Branding and Publish branding), then 0d, then 0e (submit). 0d
  can't start before 0b is finished: the video must show the app name on Google's screen.
```

**LAUNCH.md step 0d.** Add as the first bullet:

```
- Branding is published (0b): Google's consent screen shows Squared Away, not the domain. If it
  shows the domain, stop and finish 0b.
```

**Assertions (`tests/unit/launch-doc.test.ts`):**

```ts
it("Check 28 P2: brand verification is in 0b, before the video", () => {
  const s = sections0();
  const step0b = s.slice(s.indexOf("**0b."), s.indexOf("**0c."));
  expect(step0b).toContain("**Verify Branding**");
  expect(step0b).toContain("**Publish branding**");
  expect(step0b).toContain("within 7 days");
  const step0d = s.slice(s.indexOf("**0d."), s.indexOf("**0e."));
  expect(step0d).toContain("Branding is published (0b)");
});
```

## Step 4: Check 28 P3 + Check 1 P7 (App emails step 6, folded in here as the plan asked)

One env, `GOOGLE_APP_STATE` (`src/config/google-app.ts`; `testing` / `unverified` / `verified`,
default `testing`), drives both the connect screen's Google-warning line and the reason line in the
"Squared Away lost access to your Gmail" email (`src/server/alerts.ts`). Today's default is right,
so it is live on merge; Davi changes the value as the app moves through Google's process.
**Integration note:** if the App emails group also changed `alerts.ts`'s footer for Check 1 P7,
keep this version (one env, as the plan's conflict 12 says) and drop theirs.

**LAUNCH.md 0c.** Add a bullet after "Where:":

```
- Then tell the app: Vercel → sa → Settings → Environment Variables → `GOOGLE_APP_STATE`
  (Production only) = `unverified` → Save → Redeploy. The Connect Gmail screen then says "Tap
  Advanced, then the link that starts with Go to" instead of "Tap Continue", which is what Google
  shows once the app is published. When Google approves the app (0g done), set it to `verified`
  and redeploy: the warning line disappears. Preview stays unset.
```

**CLAUDE.md** (Decisions): `GOOGLE_APP_STATE` (Production only; testing / unverified / verified,
default testing) is the one switch for what Google's consent screen shows; the connect screen's
warning line and the access-lost email's reason read it (`src/config/google-app.ts`). Never add a
second env for the same fact.

## Step 6: Check 28 P5 (LAUNCH.md text; casa-prep.md and the workflow are on the branch)

`poweredByHeader: false` was already in `next.config.ts` (Check 26 P9, with its test in
`security-headers.test.ts`), so that part was skipped. The workflow was **not run**: running it
needs a push to GitHub, which builders don't do. Integrator: after merging, run Actions → CASA
pre-scan once on the branch and read the two artifacts.

**LAUNCH.md 0g.** Add a bullet before "Worked when":

```
- Before paying a lab, run the pre-scan (GitHub → Actions → **CASA pre-scan** → Run workflow) and
  have the engineers clear every high and medium finding, or list each as an accepted risk with
  its reason in `docs/casa-prep.md` (the evidence file the lab's questionnaire is answered from).
  Add the yearly key rotation (`docs/SETUP.md` §5a) to the same 60–90-day reminder.
```

## Step 7: Check 28 P6 (LAUNCH.md text; the script is `pnpm google:ready <url>`)

Run on 2026-10-19 against `https://sa-dac3.vercel.app`: 8 FAIL lines, exactly today's known gaps
(`[To confirm]` in the terms, no contact email on /privacy and /terms, the vercel.app host,
`x-robots-tag: noindex` on all three pages, `x-powered-by` on `/`), everything else PASS.

**LAUNCH.md 0e.** Add a bullet before "Paste:":

```
- Before Submit, have the engineers run `pnpm google:ready https://<your domain>` (it reads the
  public pages the way Google's reviewer does: no sign-in, the privacy link, the Limited Use
  sentence, a contact email, no `[To confirm]`, your own domain, no noindex). Every line must say
  PASS. Worked when: the last line says "All checks passed".
```

## Step 8: Check 28 P7 (CLAUDE.md line)

**CLAUDE.md** (admin notes): `/admin/video` (Check 28 P7) renders the demo video script from
`docs/google-verification.md` (`src/server/video-script.ts`, pure parser; 17 steps pinned by
`tests/unit/video-script.test.ts`) as 44px tick boxes kept in localStorage only; three fixed
reminders (desktop tab, demo Gmail only, YouTube Unlisted). No loading.tsx (must 404); listed in
the a11y, tap-target and noindex admin page lists.

## Step 9: Check 33 P5 (LAUNCH.md text only)

**LAUNCH.md step 5.** Add a new item 10 at the end of the "Production domain" list:

```
10. **Let search engines in.** Every page on `sa-dac3.vercel.app` is sent with
    `x-robots-tag: noindex` today, so the domain move is the moment search starts. Do these in
    order, right after item 9.
    1. Where: a terminal in the project folder. Paste: `pnpm check:headers https://<your domain>`.
       Worked when: it prints "All checks passed" (no noindex on `/`, `/growth`, `/privacy`,
       `/terms`, and `/favicon.ico` answers 200). Previews are expected to fail this: Vercel adds
       noindex to every preview on purpose.
    2. Open `https://<your domain>/sitemap.xml` and `https://<your domain>/robots.txt`. Worked
       when: every address in both starts with your domain, not `vercel.app` (they come from
       `APP_URL`, so a missed redeploy shows up here).
    3. View the page source of `https://<your domain>/` and `/growth` (right-click → View page
       source) and find `rel="canonical"`. Worked when: both point at your domain.
    4. Google Search Console → the domain property → **Sitemaps** → paste `sitemap.xml` → **Submit**.
       Then **URL Inspection** → paste `https://<your domain>/` → **Request indexing**; do the same
       for `https://<your domain>/growth`. Worked when: Sitemaps shows **Success** and both
       inspections say the request was sent.
    5. Bing Webmaster Tools (bing.com/webmasters) → **Import from Google Search Console** → pick the
       domain. Worked when: Bing lists the site and the sitemap.
    6. A week later: Search Console → **Pages**. Worked when: `/` and `/growth` show as indexed. If
       one says "Excluded by 'noindex' tag", re-run item 1.
```

**LAUNCH.md step 13 ("Decided on 2026-10-16" list, the bullet "Turn on Web Analytics … and submit
the sitemap in Google Search Console").** Replace "and submit the sitemap in Google Search Console"
with "and let search engines in ([step 5, item 10](#5-support-email-and-the-production-domain))",
so there is one place for it.
