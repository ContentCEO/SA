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
