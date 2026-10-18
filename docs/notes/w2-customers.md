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
  reads "You updated your crew list (N addresses)". **Crew** = on that list or one of the
  workspace's own connected Gmail addresses: `isCrewAddress` (`sender-rules.ts`, pure) and its
  SQL twin `crewSql(workspaceId, address)` (`thread-sql.ts`, parity-tested). **Adapted:** 22 P10
  also named "the owner's own non-webmail business domain"; that wider rule
  (`{ includeDomain: true }`) is used only to file a Customers row under "Your crew and subs".
  Sorting, drafts, autopilot and the counts use the strict rule, because an owner on an internet
  provider's domain we don't list as webmail (charter.net, cox.net, sbcglobal.net…) shares it with
  customers, and a customer taken for crew would be sorted without the model, get no draft and
  never be needs-you. (The e2e fixtures put owner and customer on example.com, which showed it.)
  Owners list their own-domain crew in Settings to get the full treatment. `crewThreadSql` = a thread whose every inbound email
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

## Step 6: Check 13 P5 (the customer page knows what the list knows)

- `customerDetail` returns `openQuotes` / `wonCents` (the same `quoteFactsByAddress` as the
  row), `owedCents` (Money's owed rows for that reply address, earlier open invoices included;
  receipt senders are already out), `lastWroteAt` (newest inbound, never a side email) and
  `addresses` (distinct trimmed `extracted.address`, max 10). The page shows one facts line
  ("1 open quote · Won $2,100 · Owes $350 · Wrote you Oct 8", owner's time zone), "Job
  addresses", and a stage line per card (`customerThreadStage`, `customer-rules.ts`: Quotes'
  stages as "Waiting on you" / "Priced, waiting on them" / "Gone quiet" / "Won $2,100" / "Lost" /
  "No answer"; other threads "Waiting on you" only when the customer wrote last). No new email
  text on the page.

## Step 7: Check 13 P6 + P7 + P8 (wording on Customers)

- Rows read "2 conversations · wrote 3 hours ago" from `CustomerRow.lastWroteAt` (their own
  newest inbound email, side emails left out; the list is sorted by it): `wroteWords`
  (`customer-rules.ts`): relative under 30 days, "in July" within the current year, else
  "Mar 2025", in the owner's time zone.
- The customer page's serif line is `headlineName` (`src/lib/headline-name.ts`): titles skipped,
  "Last, First" → First, a company word (llc, inc, group, property, properties, mgmt,
  management, supply, dept, department, town, city) or three or more words → the whole name,
  no name → "this customer" (never the address).
- Under the intro: "From email since <date>, 30 days before you connected Gmail. People you
  emailed first show up once they write back." (`listStartsOn`: the workspace's first mailbox
  row's `created_at` minus `BACKFILL_DAYS`; `connected_at` moves on reconnect). An empty
  search: "No one matches that. They may have written from another address, or before <date>."

## Step 8: Check 13 P9 (customer names link to their page)

- `customerKeySql` (`thread-sql.ts`): the newest inbound email on the thread whose reply
  address is the thread's customer and that `customerByKey` would accept (inbox, not junk, no
  lead channel, not a robot), as an opaque uuid. Selected by `listQueue` (one extra query for
  the shown threads), `listQuotes` and Money (`MoneyRow.customerKey`); the name on Queue (draft
  and needs-you cards; never a voicemail / text / lead-site card), Quotes and Money cards is a
  `CustomerName` link (`src/components/app/customer-name.tsx`, 44px, name underlined) to
  `/customers/<key>`, or plain text when there's no page. No address in any URL.
- Inbox cards were left to Check 10 P6 (Inbox group); `customerKeySql` is there for it.

## Questions for Davi

1. **Own-domain crew.** Anyone on the owner's business domain (mike@shop.com) is filed under "Your
   crew and subs" on Customers, but is still sorted and drafted like anyone else unless the owner
   adds them to "Your crew's email addresses". Built that way because an owner on an internet
   provider's address (charter.net, cox.net) shares the domain with customers. OK, or should the
   whole domain count everywhere for owners on their own business domain?
2. **Crew mail and the AI.** A crew-only conversation is sorted without the AI (as scheduling,
   needs nobody) unless a safety check fires (gas, CO, electrical, bank change, attack). The two
   review prompts disagreed (one said keep the AI's kind). OK as built?
3. **Customers before the first year.** Big jobs from people not in the mail we've read say "Big
   job from someone who hasn't written in the mail we've read so far." Reading more than 30 days
   back on connect (so returning customers are recognised) would mean storing more mail: your
   call (Check 41 "Your calls").
4. **Won amounts on Customers.** Customers no longer runs the Quotes screen's work, so a won amount
   appears once Quotes has been opened or the daily job has run. OK?

## Integration notes (expected overlaps)

- `src/server/classification.ts` / `src/ai/classify.ts`: Prompt versions (classify.v6 should take
  the `"unknown"` first-time wording above), Safety guards follow-ups, Town lists.
- `src/server/drafts.ts` (`createDraftForThread` reason `crew`, `QueueItem.customerKey`,
  `listQueue` key query) and `src/app/(app)/queue/*` (`CustomerName` on draft / needs-you cards):
  Queue screen group.
- `src/server/quotes.ts`, `src/server/money.ts`, `src/app/(app)/quotes|money/page.tsx`
  (`customerKey`, `CustomerName`, crew filter on `listQuotes`): Quotes and Money group.
- `src/server/scorecard.ts`, `src/server/leads-at-risk.ts`, `src/server/first-week.ts` (one crew
  WHERE line each): Numbers and Activity group.
- `src/app/(app)/inbox/page.tsx` ("Your crew" tag): Inbox group; `customerKeySql` is ready for
  Check 10 P6.
- `src/components/forms/business-profile-form.tsx`, `src/server/profile.ts`,
  `src/server/profile-defaults.ts`, `src/app/(app)/settings/business/page.tsx` (crew field):
  Settings and time zone group.
- `src/server/autopilot.ts` (crew guardrail line): Autopilot rules group.
- `src/server/thread-sql.ts`: shared helpers added (`crewSql`, `crewThreadSql`,
  `customerRobotSql`, `customerKeySql`); `noReplySql` now also reads `MACHINE_SENDER_DOMAINS`.
- No migration, no prompt file.
