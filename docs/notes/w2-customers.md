# Notes from `w2-customers` (wave 2, Customers and senders)

For the integrator to fold into `CLAUDE.md` (Decisions), `docs/LAUNCH.md` and the privacy policy.

## Step 1: Check 13 P1 + Check 22 P10 + Check 41 P6 (crew, suppliers, towns)

Proposed `CLAUDE.md` decision text:

- **Crew and kinds on Customers (Check 13 P1 + 22 P10 + 41 P6, wave 2):** one crew list,
  `business_profile.crew_addresses` (the column wave 0 reserved; no migration), edited in
  Settings → Your business as "Your crew's email addresses (one per line, optional)" with the help
  line "Their emails stay in your inbox but aren't customers and don't get drafts."
  (`crewAddressesSchema`: emails, lowercased, de-duplicated, max 30; a form without the field
  leaves the list alone). A changed list logs `crew_list_saved` with `{ count }` only; Activity
  reads "You updated your crew list (N addresses)". **Crew** = on that list, one of the
  workspace's own connected Gmail addresses, or on a connected mailbox's business domain (never
  public webmail): `isCrewAddress` (`sender-rules.ts`, pure) and its SQL twin `crewSql(workspaceId,
address)` (`thread-sql.ts`, parity-tested); `crewThreadSql` = a thread whose every inbound email
  is crew (so a customer's thread the crew replied on is never a crew thread);
  `crewContextFor` / `isCrewFor` (`src/server/crew.ts`) read the list live.
  - Sorting (`classifyPending`): a thread whose every inbound email (From **and** reply address)
    is crew is stored as `scheduling`, priority low, needs nobody, `extracted.crew = true`,
    summary "From your crew: <subject>", with **no model call** — unless a check in code fires
    (gas, CO, electrical, new bank account, attack; or a sticky injection / payment-change mark,
    or the owner moved its kind): then the sorter reads it as usual and the crew mark is added
    (so "I smell gas at the Smith job" is needs-you, top priority). Where the two prompts
    disagreed (22 P10: no model call; 41 P6: keep the model's kind), 22 P10 won: it saves AI
    cost and sends the crew's mail to nobody.
  - Drafts: jobs (auto, follow-up, the safety note) skip `crew` when the thread has the crew
    mark **or** the reply would go to a crew address (read live, so adding a name today stops
    drafts on older threads, and an auto draft never answers the crew's reply on a customer's
    thread). The owner's own "Draft a reply" still drafts. Autopilot guardrail: "Emails to your
    crew always wait for you." (`extracted.crew` or a crew `To`).
  - Customers: every row has `kind` (`customerKind`, pure in `customers.ts`): town
    (`looksMunicipal` on any of their sender name/address pairs, or `extracted.municipal`) →
    crew (`crewSql`, or every inbound email from them is a side email: the sub who only replied
    to the owner's Fwd:) → supplier (more than half of their conversations `supplier_vendor`) →
    customer. The list shows customers; "Suppliers (n)", "Towns and inspectors (n)", "Your crew
    and subs (n)" links (44px) switch the group with `?group=suppliers|towns|crew` (no name or
    address in the URL). The " · supplier" suffix is gone. Intro: "People who've emailed you about
    work. Suppliers, towns and your crew are kept apart."
  - Quotes (`listQuotes`) and first-week found money leave crew threads out (`crewThreadSql`);
    leads at risk and the scorecard's response time leave out a crew waiting/requesting address
    (`crewSql`, next to `noReplySql`).
  - Inbox cards say "Your crew" in place of the kind for `extracted.crew` threads.
- Privacy policy, "What you tell us": "Your crew's email addresses, if you list them, so their
  emails aren't treated as customers. They stay with your account until you remove them or
  delete your account."

## Step 2: Check 13 P2 + Check 22 P7 + Check 41 P7 (robots, lead-site first contacts, job boards)

Proposed `CLAUDE.md` decision text:

- **Robots off Customers (Check 13 P2 + 41 P7, wave 2):** `isNoReplyAddress` also covers the
  job boards on `MACHINE_SENDER_DOMAINS` (`sender-rules.ts`: indeed.com, indeedemail.com,
  ziprecruiter.com, glassdoor.com, snagajob.com — the domain and its subdomains, any local part;
  craigslist left out, its relays are people; `noReplySql` reads the same list), so drafts,
  Customers, leads at risk and the scorecard skip them with no other change. Customers uses
  `customerRobotSql` (`thread-sql.ts`), the SQL twin of `isCustomerRobot`
  (`customer-robot-rules.ts`, pure, parity-tested): no-reply / job board, a website form's robot
  (`looksLikeFormSender`'s `FORM_SENDER_DOMAINS` / `FORM_SENDER_LOCAL_PATTERN`, now exported),
  a lead platform's own address that isn't a per-customer relay (`LEAD_RELAY_LOCAL_PATTERN` in
  `config/lead-sources.ts`: `reply+…` or any `+`), or a receipt domain
  (`RECEIPT_SENDER_DOMAINS`). Applied to the reply address, so a Squarespace lead with a usable
  Reply-To is the person. `customerByKey` opens a page only for an email that is itself on the
  list (`listedMessage`: inbox, not junk, not a robot, not a lead site's notice), so a junk or
  robot email's id is a 404.
- **First-time sender for lead sites and voicemail (Check 22 P7):** when the From is a no-reply
  address or a lead platform and there is no usable Reply-To, "first time" is `"unknown"`
  (counts as first time for the big-job rule; `applyOwnerRules` takes `boolean | "unknown"`). A
  voicemail-by-email (`channel.kind === "phone"`) whose subject names a number is first time
  unless an earlier voicemail from that service named the same number (`voicemailFirstTime`);
  no number → `"unknown"`.

For the Prompt versions group (classify.v6; this group writes no prompt files): the prompt still
reads `yes` for `"unknown"` (classification passes `firstTimeSender !== false`). The intended
change, in `emailBlock` of the next classify version, with `EmailInput.firstTimeSender: boolean |
"unknown"`, and classification.ts passing the raw value:

```ts
First time this sender has emailed the business: ${e.firstTimeSender === "unknown" ? "unknown (a lead site or voicemail service; judge the person from the email)" : e.firstTimeSender ? "yes" : "no"}
```

Eval case to add with it (tests/evals/cases.ts): a second Thumbtack lead for a home addition from
the same `leads@thumbtack.com` address, `large_request`, expected needs-you with the big-job reason.

## Step 3: Check 13 P3 (every customer findable)

- **Customers reads everyone (Check 13 P3):** no 500 cap (`CUSTOMERS_CEILING` 10,000; only
  `customers_ceiling_hit { workspaceId, count }` is logged past it). The page sends compact items
  and draws 50 at a time ("Show 50 more", 44px); search still filters the full list on the phone.
  "N customers" under the heading. Quote facts come from one read-only query
  (`quoteFactsByAddress`: open = quote thread with no outcome, won = sum of `quote_amount_cents`),
  so the Customers page never runs `captureQuoteAmounts` / `guessNoAnswers` and has no 300-quote
  cap. A won amount shows once Quotes or the daily job has captured it.

## Step 4: Check 13 P4 (one name per customer)

- `newestNameSql` (`customers.ts`): the newest non-empty reply name over the customer's inbound
  mail, used by both `listCustomers` and `customerDetail`, so the row and the page can't differ.

## Step 5: Check 41 P5 (no "New customer" for last year's customers)

- The big-job needs-you reason is `bigJobReason(historyDays)` (`src/ai/classify.ts`):
  "Big job from someone who hasn't written in the mail we've read so far." while the mailbox
  holds under 365 days of mail (now minus its oldest synced email, read once per
  `classifyPending` run; unknown counts as under a year), else "Big job from someone new." The
  rule itself is unchanged. No other screen showed the old "New customer asking about a big
  job." text (cards read the `big_new_job` hit key). Widening the backfill or keeping more
  addresses was not done: Davi's call (see Questions).
