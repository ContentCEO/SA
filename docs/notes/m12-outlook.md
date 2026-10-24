# Notes from `m12-outlook` (plan #49, Outlook / Microsoft 365)

Built behind `FEATURE_OUTLOOK` (off). Outlook is offered only when the switch is on **and**
`MS_CLIENT_ID` and `MS_CLIENT_SECRET` are both set (`src/config/outlook.ts`, `outlookOffered()`).
Off, nothing changes: no Outlook button or wording, `/api/outlook/*` answer 404 (notify) or send
the owner back to Connect (callback), the daily job's Outlook step returns before any query, the
CSP is unchanged, the waitlist rule is unchanged, and no Microsoft host is contacted (an Outlook
client with the switch off refuses to refresh a token). The enum value `outlook` is unused until
an owner connects through the switch.

Legal sentences (privacy policy and terms) are in `docs/notes/legal-m12-outlook.md`.

## For CLAUDE.md / docs/decisions (gmail-and-sync.md, queue-and-sending.md)

- **Outlook (#49, 2026-10-24):** `src/mailbox/outlook/` over Microsoft Graph, plain `fetch`
  (`http.ts`: one request path; `Prefer: IdType="ImmutableId"` on every request; refresh with
  rotation through `onRefreshTokenRotated`, **single-flight** because Microsoft rotates the
  refresh token every time and parallel refreshes would present a replaced one; 401 re-refresh
  once → `MailboxAuthError`; `invalid_grant` / `interaction_required` / `unauthorized_client` →
  `MailboxAuthError`; `invalid_client` (our own secret expired) is a plain error, never
  "reconnect"; 429/503/504 with Retry-After ≤ 60 s slept, longer → `MailboxRateLimitError` with
  the time, else full-jitter backoff; permanent 403 → `MailboxAuthError`; errors carry status +
  Graph's error code only, never Graph's message text). Built only in `mailboxClientFor`.
- Permissions: exactly `Mail.ReadWrite`, `Mail.Send`, `offline_access`, `User.Read`. Any of the
  first three missing from the token's `scope`, or no refresh token, → `MissingScopesError`,
  nothing saved (the tokens are simply dropped; Microsoft has nothing to revoke).
- Connect: Microsoft's `common` endpoint (work and personal accounts), `prompt=consent`
  (`select_account` for "Connect another Outlook"; Microsoft takes one prompt value), PKCE S256
  (the verifier lives in the httpOnly state cookie `sa_outlook_oauth_state`, path `/api/outlook`,
  10 minutes, next to the random state compared in constant time). The address = `/me` `mail`,
  else `userPrincipalName`. A Microsoft account with no mailbox Graph can reach →
  `NoOutlookMailboxError` (`?error=no_outlook`). The same address already connected through the
  other provider is refused (`MailboxProviderMismatchError`, `?error=other_provider`), never
  switched silently.
- Sync: thread = `conversationId`. Folders map onto `MAIL_LABELS` (inbox, Sent Items, Drafts,
  Deleted Items → TRASH, Junk → SPAM; Archive and the owner's own folders = no label, like an
  archived Gmail email). **No Promotions / Social mapping:** Focused / Other is not the same thing
  (real customers land in Other), so every Outlook email is sorted by the model. Unsent drafts are
  never stored (`isDraft` → DRAFT label → `isUnsentDraft`). Bodies come as text via
  `Prefer: outlook.body-content-type="text"`; attachment counts by content type only (one extra
  call, only for full reads that have attachments).
- Listing: `receivedDateTime ge <start>`, newest first, Graph's `@odata.nextLink` as the page
  token (a 400 on a saved one → `InvalidPageTokenError`). "Not the inbox" = all mail minus inbox,
  Drafts, Deleted, Junk, filtered in code.
- Incremental sync: per-folder **delta** queries (inbox, Sent Items, Deleted Items, Junk), each
  `$filter=receivedDateTime ge` 30 days before the cursor was made (Graph allows exactly that
  filter on message delta). The cursor in `mailboxes.history_id` is opaque to shared code:
  `o1.` + base64url JSON of the four delta links. One `listHistory` page = one Graph page per
  folder still mid-round; only the last page's cursor is stored. The first round after a backfill
  re-lists the window (nothing is stored twice). Moves become label changes (into the inbox:
  +INBOX −TRASH −SPAM; out of it: −INBOX; into Deleted: +TRASH −INBOX; into Junk: +SPAM −INBOX).
  `deleted` is always empty: Graph's `@removed` can't tell a permanent delete from a restore. A
  410 (or 400) on a delta link → `HistoryExpiredError` → the existing re-read. `getProfile`
  makes the fresh cursor without paging (the first delta round does that).
- Drafts: created from our own MIME (`POST /me/messages`, base64, `Content-Type: text/plain`),
  never `createReply`. **Update = PATCH of the parts** read back from the MIME we built
  (`mime-parts.ts`: subject, HTML part, To/Cc), not delete-and-recreate: the id stays (so
  `drafts.gmail_draft_id` stays right without an interface change) and the threading headers set
  at creation stay. Delete only while still a draft: with immutable ids, a sent draft's id is the
  Sent Items copy, and deleting it would remove the owner's sent email. Send =
  `POST /me/messages/{id}/send` (202, no body) after a read that checks it's still a draft; the
  sent id is the draft's own id. The practice copy (`sendMessage`, trial only, `onlyToOwner()`
  already checked the MIME) is a draft then sent, so it has an id (`sendMail` has none and is
  never used). `listSendAs` isn't implemented: Outlook replies go from the connected address.
- Push: Graph change subscriptions on `me/messages` (`created,updated,deleted`), 10,000 minutes
  (Graph's limit is 10,080), renewed by the daily `renew-gmail-watches` job's new
  `renew-outlook` step when under two days are left; a renew Graph answers 404 makes a new one.
  Only running Outlook mailboxes of accounts that may run jobs, after their first read. The
  random `clientState` is stored only as its sha256 (`mailboxes.push_client_state_sha256`), the
  subscription id in `push_subscription_id`, the expiry in `watch_expires_at`.
  `/api/outlook/notify`: 404 unless offered; echoes `validationToken` (text/plain, nosniff);
  otherwise each notification's clientState is checked in constant time and only the mailbox's
  sync is enqueued — a batch with no match and a wrong clientState is 403, an unknown
  subscription (an orphan after Disconnect) is acknowledged. No lifecycle notifications are
  handled: **the 5-minute poll always syncs Outlook mailboxes** (`pollDue` counts push only for
  Gmail), so a lapsed subscription costs at most five minutes. Gmail's `renewWatches` skips
  Outlook rows.
- Disconnect / Delete my account: revoke goes to the token's own provider
  (`connectorForRow`: the Gmail connector the Settings action passes is never used for an Outlook
  row, so a Microsoft token never reaches Google's revoke). Microsoft has no per-app revoke
  (`ProviderCannotRevokeError` → `revokedAtProvider: false`); our tokens and the mailbox are
  deleted anyway, the Graph subscription is dropped first (best effort), and the screen says
  where to remove the app (account.microsoft.com → Privacy → Apps and services, or
  myapps.microsoft.com for work accounts). Notice `?done=disconnected_outlook`.
- Waitlist / admin: while Outlook is offered a `microsoft` mail-host row is invited without
  "Invite anyway" (`needsInviteConfirm(mailHost, outlookOffered())`); off, unchanged.
- CSP `form-action` adds `https://login.microsoftonline.com` only while offered (headers are
  built at build/start: turning the switch on needs a redeploy anyway).
- Fences: security-surface lists `/api/outlook/callback` (session+state) and
  `/api/outlook/notify` (new guard `graph-client-state`), the Outlook connect redirect (C4) and
  its rate limit; "names send endpoints only in the provider clients" now also recognises Graph's
  `/send` and `/sendMail` in provider code and allows `src/mailbox/outlook/writer.ts` (no
  `sendMail`); `sendDraft` / `practiceSend` remain the only two send sites. data-paths:
  `graph.microsoft.com` and `login.microsoftonline.com` in `FETCH_HOSTS_AWAITING_POLICY` (their
  line is in the legal note until the policy has it). e2e-mode boundary: the new seam
  `microsoftEndpoints` (`SA_E2E_MICROSOFT_BASE_URL`) imported by `outlook/connector.ts` and
  `outlook/http.ts`.
- e2e: a second app on `PORT+2` with Outlook on runs `tests/e2e/outlook.spec.ts` (project
  "outlook"); `tests/e2e/outlook-off.spec.ts` checks the normal app has none of it. The Graph
  stand-in is `tests/support/fake-graph.ts` (unit tests use it as fetch; `tests/e2e/fakes/
microsoft.ts` serves it under `/microsoft`).
- Migrations: `0081_outlook_provider` (`ALTER TYPE mailbox_provider ADD VALUE 'outlook'`, alone)
  and `0082_outlook_push_subscription` (two nullable columns + a unique index). Both additive.

## Turning the switch off again

With Outlook mailboxes still connected, their jobs fail closed: the Outlook client refuses to
refresh a token while Outlook isn't offered, so no Microsoft host is contacted, and each sync
shows as `sync_failed` in Settings → Your Gmail. Disconnect them first (Disconnect works with the
switch off; it only skips dropping the Graph subscription, which then expires within a week).
The reconnect banner, the "access lost" email and the queue's lost-access lines still say
"Gmail" for an Outlook mailbox; the banner and Settings button say "Reconnect Outlook".

## Not checked live (no Azure app in the sandbox)

- That Exchange puts a MIME-uploaded reply into the customer's conversation by its
  In-Reply-To / References (the writer logs `outlook_draft_new_conversation`, ids only, if the
  created draft's `conversationId` differs; the app still ties the draft to its own thread).
- That a draft's text read back as text equals what we wrote closely enough for `sameText`
  (Exchange converts our HTML part); a mismatch would read as "changed in Outlook" and ask the
  owner to tap Send again (safe, but annoying).
- Exact error codes for an expired delta link (we treat any 410 or 400 on a delta link as
  expired) and for a mailbox not on Exchange Online.
- To check, with Davi's test app: connect a test outlook.com account, get one draft, edit it in
  the app (PATCH), send it, and confirm the Sent Items copy is in the same conversation with the
  same id; let a delta link sit for a week and see the 410.

## For docs/LAUNCH.md step 13 (decisions waiting on Davi)

**Outlook / Microsoft 365 (plan #49): built and tested, off.** To turn it on (docs/SETUP.md §8b):

1. Register the app in the Microsoft Entra admin center (entra.microsoft.com → App
   registrations → New registration): "Squared Away"; account types **any organizational
   directory and personal Microsoft accounts**; redirect URI (Web)
   `https://<production domain>/api/outlook/callback` (and
   `http://localhost:3000/api/outlook/callback` for local work).
2. `MS_CLIENT_ID` = the app's "Application (client) ID"; `MS_CLIENT_SECRET` = Certificates &
   secrets → New client secret → the **Value** (sensitive; calendar a reminder before it expires
   — an expired secret stops every Outlook mailbox until replaced, and is reported as an error,
   not as "reconnect").
3. API permissions → Microsoft Graph → Delegated: `Mail.ReadWrite`, `Mail.Send`,
   `offline_access`, `User.Read` — exactly these four.
4. Publisher verification: a verified Microsoft AI Cloud Partner Program account and a publisher
   domain that isn't `*.onmicrosoft.com` (the production domain, verified under Branding &
   properties), then "Add MPN ID to verify publisher". Without it owners see "unverified" and
   many work tenants block the app.
5. Put the sentences in `docs/notes/legal-m12-outlook.md` into the privacy policy and terms (one
   legal release, new `TERMS_VERSION`), then move the two Microsoft hosts from
   `FETCH_HOSTS_AWAITING_POLICY` to `FETCH_HOSTS` in `tests/unit/data-paths.test.ts`.
6. Vercel → `FEATURE_OUTLOOK=1`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` on **Production only**
   (previews sit behind Vercel login, so Microsoft can't reach `/api/outlook/notify` there; the
   poll still syncs). Redeploy.

Questions for Davi, plain words:

- Should Outlook be offered to everyone once it's on, or only to owners you invite who are on
  Microsoft (the switch is all-or-nothing today)?
- The connect screen's title becomes "Connect your email" while Outlook is on. Fine?
- Outlook's "Other" tab isn't treated like Gmail's Promotions (every email is sorted by the AI,
  which costs a little more per Outlook owner). Fine, or should "Other" newsletters skip sorting?

## Expected conflicts with other branches

- `docs/SETUP.md` (§4 table rows, §6d bullet, §8b, §3), `.env.example` (feature switches block),
  `src/config/features.ts`, `src/config/e2e.ts`, `playwright.config.ts` (now an `appEnv`
  constant shared by two app servers), `tests/unit/security-surface.test.ts`,
  `tests/unit/data-paths.test.ts`, `tests/unit/e2e-mode.test.ts`, `src/jobs/functions.ts`
  (one step in `renewGmailWatches`), `src/server/sync.ts` (`renewWatches` / `listSyncableMailboxes`
  filters), `drizzle/` (0081, 0082: renumber at merge). The #50 (texts) builder in SA-launch is
  likely to touch `.env.example`, SETUP §4 and the feature switches too.
