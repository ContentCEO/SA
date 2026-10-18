# Build order for the review prompts

Each numbered step is one builder session. Steps joined with + are done together in one session as
one change. Steps in a group run in order. Groups in the same wave may run at the same time. [M]
means the step adds a migration: only one [M] step may be open at any time, across all groups. C09
P1 means Check 9, prompt P1.

The rules for working side by side (branch names, the migration lane, shared files, notes) are in
`CLAUDE.md` under "Working in parallel".

## Already built

Three packages were built in parallel outside this order and merged by the integrator on top of
wave 0 on 2026-10-17 (migrations `0036_decisions`, `0037_replies`, `0038_growth`). Don't redo
them:

- **Decisions:** trial emails and their wording, paused mailboxes on a lower plan, the test-payment
  reset, the "Other" lost reason, and the paid-invoice thank-you (prompt `purpose.v2`).
- **Replies:** warm first replies (prompts `draft.v7` and `opening-tweaks.v1`), money totals in the
  morning email, and emergency alerts at night (voicemails included).
- **Growth client portal:** the pledge, the agreement draft, the More screen's Growth line, Remove
  on a Growth request, and `/start`, `/my-growth` and `/admin/growth` — numbers Davi enters by hand
  only (nothing from anyone's inbox).

The referral offer (plan #47 offer A, behind `FEATURE_REFERRALS`, off) was merged on top of
those on branch `referral-offer-a` the same day (migrations `0039_referral_free_month` and
`0040_referral_after_end_check`, renumbered to `0044` / `0045` after wave 1 on 2026-10-18), with one plan pause for both (the decisions package's
`plan_paused_at`) and Davi's 2026-10-16 rule that a Growth request can earn a referral.

Because `draft.v7` and `purpose.v2` are taken, the review pages' "draft.v7" bundle is `draft.v8`
here. The whole version plan (draft.v8 / v9, classify.v5, followup.v5, voice.v3, purpose.v3) is in
`CLAUDE.md` under "Prompt versions".

## Before you start a step

1. Find the step for the prompt you were given.
2. Every earlier step in its group is merged into `claude/squared-away-mvp-ddxl7s`, or stop and
   name the step that has to go first.
3. For an [M] step, the migration lane is free ("Working in parallel" rule 3 in `CLAUDE.md`), or
   stop.
4. For a step with +, ask Davi to paste every prompt in it and do them as one change with one
   migration at most.
5. The problem still exists at the tip of `claude/squared-away-mvp-ddxl7s`.
6. After the change, run `pnpm lint`, `pnpm typecheck` and `pnpm test`, plus
   `pnpm build && pnpm test:e2e` when a screen changed
   (`PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium` in a sandbox), and
   `pnpm eval --no-drafts` when a prompt file changed if `ANTHROPIC_API_KEY` is available (else say
   it wasn't run).

## The order

Wave 0 (Before anything else; This week, one builder, nothing else running):

- Ground rules and safety nets: 1) C49 P4 + C50 P1; 2) C26 P1; 3) C30 P2; 4) C31 P2; 5) C50 P3 [M]; 6) C50 P2; 7) C31 P1; 8) C05 P1 + C02 P5; 9) C48 P7; 10) C16 P11; 11) C26 P2; 12) C31 P3; 13) C49 P1

Wave 1 (The promise and safety (most Must fix items, with the smaller fixes to the same files); Weeks 1–2, groups side by side):

- Send path: 1) C09 P1; 2) C42 P1 + C14 P1 [M]; 3) C09 P2 [M]; 4) C42 P2; 5) C08 P1 + C09 P3 + C09 P4; 6) C43 P7; 7) C43 P9; 8) C09 P10; 9) C38 P1
- Safety guards: 1) C22 P4 + C36 P1; 2) C39 P1; 3) C22 P3 + C20 P5; 4) C36 P2; 5) C37 P1; 6) C22 P2; 7) C48 P1 + C43 P2; 8) C22 P1; 9) C22 P5; 10) C22 P11 + C36 P6 + C45 P4; 11) C38 P3 + C22 P6 + C39 P2
- Draft checks: 1) C20 P1 + C23 P3 + C23 P4; 2) C23 P1 + C20 P11 + C36 P10; 3) C23 P2 + C38 P6 + C36 P7 [M]; 4) C40 P1; 5) C41 P1; 6) C39 P4 + C37 P5; 7) C38 P7; 8) C23 P5; 9) C38 P2; 10) C23 P6; 11) C23 P7; 12) C23 P10; 13) C23 P13; 14) C23 P14
- When things break: 1) C18 P1; 2) C16 P1; 3) C17 P1 [M]; 4) C16 P2; 5) C29 P1; 6) C48 P3 [M]; 7) C48 P4; 8) C01 P4; 9) C50 P6
- Homepage words: 1) C06 P1; 2) C06 P2 + C06 P3 + C06 P7 + C34 P6; 3) C06 P4 + C06 P5 + C34 P2 + C34 P3; 4) C34 P1 + C35 P2 + C35 P5; 5) C35 P4 + C35 P3; 6) C35 P1; 7) C06 P8 + C06 P9 + C06 P10 + C34 P5 + C42 P7

Wave 2 (Screen by screen (each group starts with its Must fix step); Weeks 3–6, groups side by side):

- Sync and Gmail connect: 1) C25 P1 [M]; 2) C25 P2; 3) C47 P1; 4) C25 P3 [M]; 5) C20 P4 + C21 P1; 6) C40 P2 [M]; 7) C25 P4; 8) C25 P5; 9) C25 P6; 10) C25 P7 [M]; 11) C42 P3; 12) C47 P2; 13) C47 P4; 14) C25 P8
- Queue screen: 1) C32 P1; 2) C09 P5 + C32 P7; 3) C09 P6; 4) C09 P7 + C09 P12; 5) C09 P9; 6) C09 P11 + C23 P8; 7) C23 P9; 8) C09 P13 [M]; 9) C09 P14; 10) C41 P2; 11) C21 P8; 12) C32 P9 + C32 P11; 13) C08 P7 + C08 P9; 14) C09 P15 + C48 P5; 15) C09 P8
- Inbox: 1) C10 P1 + C11 P8 [M]; 2) C10 P3; 3) C10 P2; 4) C10 P4 + C10 P5; 5) C10 P6; 6) C10 P7; 7) C10 P8; 8) C10 P9 + C10 P10
- Quotes and Money: 1) C11 P1; 2) C11 P2 + C39 P3 [M]; 3) C11 P3 [M]; 4) C11 P4; 5) C11 P5; 6) C11 P6; 7) C11 P7; 8) C11 P9; 9) C12 P4; 10) C12 P5; 11) C12 P6; 12) C12 P8 + C12 P9
- Follow-ups: 1) C12 P1; 2) C21 P2 [M]; 3) C21 P3; 4) C21 P4 [M]; 5) C21 P5; 6) C21 P6; 7) C36 P3; 8) C38 P4 [M]
- Prompt versions (one at a time, evals after each): 1) C12 P2 + C12 P3 + C22 P9 + C38 P5 + C45 P7; 2) C23 P11 + C43 P1 + C44 P1 + C45 P2; 3) C36 P8 + C37 P4 + C39 P6; 4) C12 P7 + C21 P7; 5) C24 P5 + C24 P9; 6) C39 P5 + C40 P4; 7) C41 P3 [M]; 8) C41 P4 [M]; 9) C22 P12 + C23 P12 + C24 P10 + C31 P5; 10) C37 P8 + C39 P8 + C40 P6
- Customers and senders: 1) C13 P1 + C22 P10 + C41 P6; 2) C13 P2 + C22 P7 + C41 P7; 3) C13 P3; 4) C13 P4; 5) C41 P5; 6) C13 P5; 7) C13 P6 + C13 P7 + C13 P8; 8) C13 P9
- Settings and time zone: 1) C15 P1; 2) C45 P1 + C44 P5 + C15 P7 [M]; 3) C15 P2; 4) C15 P3; 5) C15 P4; 6) C15 P5; 7) C15 P6 + C24 P11; 8) C15 P8 [M]; 9) C43 P8 [M]; 10) C15 P9 + C15 P10 + C15 P11 + C15 P12
- Voice: 1) C24 P1 + C29 P2 [M]; 2) C24 P2; 3) C24 P3; 4) C24 P4; 5) C24 P6; 6) C24 P7; 7) C24 P8; 8) C24 P12
- Autopilot rules: 1) C20 P2; 2) C20 P13; 3) C20 P3; 4) C20 P8; 5) C20 P7 [M]; 6) C20 P6; 7) C20 P9; 8) C20 P10 [M]; 9) C48 P6
- Data and speed: 1) C30 P1 + C29 P6 + C30 P4 [M]; 2) C30 P3; 3) C30 P6 [M]; 4) C29 P7; 5) C29 P4 + C29 P5; 6) C29 P3
- Phone look and accessibility: 1) C32 P2 + C08 P2 + C08 P5; 2) C08 P3; 3) C08 P4; 4) C32 P5; 5) C32 P3 + C32 P4; 6) C32 P6; 7) C32 P8; 8) C32 P10; 9) C32 P12; 10) C08 P6 + C08 P8 + C08 P10; 11) C07 P2; 12) C07 P3; 13) C07 P5 + C07 P9 + C07 P11 + C01 P5 + C03 P8
- Mail format: 1) C43 P3 [M]; 2) C42 P4 [M]; 3) C43 P4; 4) C43 P5; 5) C43 P6; 6) C43 P10
- Town, utility and job-kind lists: 1) C22 P8 + C36 P5 + C37 P6 + C40 P7 + C44 P4 + C45 P3; 2) C37 P3; 3) C36 P4 + C37 P2; 4) C36 P9 + C37 P7 + C38 P8 + C39 P7 + C40 P5 + C41 P8
- Numbers and Activity: 1) C14 P2; 2) C14 P3 + C14 P4; 3) C14 P5; 4) C14 P6 + C14 P7; 5) C14 P8; 6) C14 P9 + C14 P10 + C14 P11; 7) C42 P5
- Billing and admin: 1) C17 P2; 2) C17 P3 [M]; 3) C17 P4; 4) C17 P5 + C01 P3; 5) C17 P6; 6) C17 P7; 7) C17 P8 [M]; 8) C17 P9; 9) C17 P11; 10) C16 P3; 11) C16 P5; 12) C16 P6 + C16 P7; 13) C16 P8; 14) C16 P9 + C16 P10 + C29 P8; 15) C05 P5
- Security and limits: 1) C26 P3 [M]; 2) C26 P4; 3) C26 P5; 4) C26 P6; 5) C26 P7; 6) C40 P3; 7) C31 P4; 8) C26 P9 + C26 P10; 9) C26 P11; 10) C31 P6; 11) C31 P7; 12) C31 P8
- Phone alerts and the app: 1) C19 P1; 2) C19 P2; 3) C19 P3; 4) C19 P4; 5) C19 P5 [M]; 6) C19 P6 [M]; 7) C19 P7 + C19 P8 + C19 P9; 8) C46 P3; 9) C46 P5; 10) C46 P1 + C46 P2; 11) C46 P4

Wave 3 (Needs an outside step first; After the domain, Resend, database split or Google):

- Legal text, one release: 1) C50 P5; 2) C27 P1; 3) C27 P2 + C27 P7; 4) C27 P3 + C27 P4; 5) C27 P5 + C27 P8 + C45 P6; 6) C27 P6; 7) C27 P9 + C27 P10; 8) C07 P1 + C07 P8
- App emails: 1) C18 P2; 2) C18 P5 + C42 P6; 3) C18 P6 + C20 P12; 4) C18 P7 + C07 P10; 5) C01 P2 [M]; 6) C01 P7; 7) C18 P4; 8) C47 P3 [M]; 9) C18 P8; 10) C18 P9
- Google review and the domain: 1) C28 P1; 2) C33 P1; 3) C28 P2; 4) C28 P3; 5) C28 P4; 6) C28 P5; 7) C28 P6; 8) C28 P7; 9) C33 P5; 10) C01 P6; 11) C33 P3 + C33 P4; 12) C33 P6
- Growth: site and form: 1) C03 P3; 2) C02 P4 + C03 P2; 3) C02 P1 + C03 P7; 4) C02 P2; 5) C02 P3; 6) C03 P1 + C03 P5; 7) C03 P6 + C34 P4; 8) C02 P6; 9) C02 P7 + C06 P6; 10) C07 P7 + C06 P11; 11) C02 P8 + C03 P4 + C05 P2 + C45 P5 + C44 P3 [M]; 12) C33 P2; 13) C07 P4 + C07 P6 + C02 P9; 14) C29 P9; 15) C26 P8
- Growth: records in /admin: 1) C50 P4 + C04 P1 + C16 P4 + C30 P5 [M]; 2) C04 P2; 3) C04 P3 [M]; 4) C04 P4; 5) C04 P5 [M]; 6) C05 P3; 7) C05 P4; 8) C05 P6

Wave 4 (Polish and the last tidy-up; Weeks 7–13, then 49-P5 alone at the very end):

- Docs and your own books: 1) C49 P2; 2) C49 P3; 3) C01 P1; 4) C17 P10; 5) C18 P3; 6) C19 P10; 7) C44 P2; 8) C47 P5; 9) C48 P2; 10) C49 P6; 11) C49 P5

## Done

When a step's pull request merges, the integrator ticks it here (`- [x]`). Only the integrator
edits this file after it is created.

- [x] Wave 0, Ground rules and safety nets, 1) C49 P4 + C50 P1
- [x] Wave 0, Ground rules and safety nets, 2) C26 P1
- [x] Wave 0, Ground rules and safety nets, 3) C30 P2
- [x] Wave 0, Ground rules and safety nets, 4) C31 P2
- [x] Wave 0, Ground rules and safety nets, 5) C50 P3 [M]
- [x] Wave 0, Ground rules and safety nets, 6) C50 P2
- [x] Wave 0, Ground rules and safety nets, 7) C31 P1
- [x] Wave 0, Ground rules and safety nets, 8) C05 P1 + C02 P5
- [x] Wave 0, Ground rules and safety nets, 9) C48 P7
- [x] Wave 0, Ground rules and safety nets, 10) C16 P11
- [x] Wave 0, Ground rules and safety nets, 11) C26 P2
- [x] Wave 0, Ground rules and safety nets, 12) C31 P3
- [x] Wave 0, Ground rules and safety nets, 13) C49 P1
- [x] Wave 1, Send path, 1) C09 P1
- [x] Wave 1, Send path, 2) C42 P1 + C14 P1 [M]
- [x] Wave 1, Send path, 3) C09 P2 [M]
- [x] Wave 1, Send path, 4) C42 P2
- [x] Wave 1, Send path, 5) C08 P1 + C09 P3 + C09 P4
- [x] Wave 1, Send path, 6) C43 P7
- [x] Wave 1, Send path, 7) C43 P9
- [x] Wave 1, Send path, 8) C09 P10
- [x] Wave 1, Send path, 9) C38 P1
- [x] Wave 1, Draft checks, 1) C20 P1 + C23 P3 + C23 P4
- [x] Wave 1, Draft checks, 2) C23 P1 + C20 P11 + C36 P10
- [x] Wave 1, Draft checks, 3) C23 P2 + C38 P6 + C36 P7 [M]
- [x] Wave 1, Draft checks, 4) C40 P1
- [x] Wave 1, Draft checks, 5) C41 P1
- [x] Wave 1, Draft checks, 6) C39 P4 + C37 P5
- [x] Wave 1, Draft checks, 7) C38 P7
- [x] Wave 1, Draft checks, 8) C23 P5
- [x] Wave 1, Draft checks, 9) C38 P2
- [x] Wave 1, Draft checks, 10) C23 P6
- [x] Wave 1, Draft checks, 11) C23 P7
- [x] Wave 1, Draft checks, 12) C23 P10
- [x] Wave 1, Draft checks, 13) C23 P13
- [x] Wave 1, Draft checks, 14) C23 P14
- [x] Wave 1, Homepage words, 1) C06 P1
- [x] Wave 1, Homepage words, 2) C06 P2 + C06 P3 + C06 P7 + C34 P6
- [x] Wave 1, Homepage words, 3) C06 P4 + C06 P5 + C34 P2 + C34 P3
- [x] Wave 1, Homepage words, 4) C34 P1 + C35 P2 + C35 P5
- [x] Wave 1, Homepage words, 5) C35 P4 + C35 P3
- [x] Wave 1, Homepage words, 6) C35 P1
- [x] Wave 1, Homepage words, 7) C06 P8 + C06 P9 + C06 P10 + C34 P5 + C42 P7
- [x] Wave 1, Safety guards, 1) C22 P4 + C36 P1
- [x] Wave 1, Safety guards, 2) C39 P1
- [x] Wave 1, Safety guards, 3) C22 P3 + C20 P5
- [x] Wave 1, Safety guards, 4) C36 P2
- [x] Wave 1, Safety guards, 5) C37 P1
- [x] Wave 1, Safety guards, 6) C22 P2
- [x] Wave 1, Safety guards, 7) C48 P1 + C43 P2
- [x] Wave 1, Safety guards, 8) C22 P1
- [x] Wave 1, Safety guards, 9) C22 P5
- [x] Wave 1, Safety guards, 10) C22 P11 + C36 P6 + C45 P4
- [x] Wave 1, Safety guards, 11) C38 P3 + C22 P6 + C39 P2
- [x] Wave 1, When things break, 1) C18 P1
- [x] Wave 1, When things break, 2) C16 P1
- [x] Wave 1, When things break, 3) C17 P1 [M]
- [x] Wave 1, When things break, 4) C16 P2
- [x] Wave 1, When things break, 5) C29 P1
- [x] Wave 1, When things break, 6) C48 P3 [M]
- [x] Wave 1, When things break, 7) C48 P4
- [x] Wave 1, When things break, 8) C01 P4
- [x] Wave 1, When things break, 9) C50 P6

Later steps are added to this list as their pull requests merge.
