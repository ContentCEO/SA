# w2-queue — wave 2 "Queue screen" (notes for the integrator)

Migration: `0044_onboarding_done` (one additive column, `business_profile.onboarding_done_at`).
Renumber at merge as usual. No prompt files changed.

## For CLAUDE.md (Decisions)

- **Queue focus (Check 32 P1):** a card button that turns into a question (Discard, Remind me
  later, I called them, a gap chip, Edit) moves focus into it (`QuestionLine` in
  `src/app/(app)/queue/focus.tsx`: the first line has `tabIndex=-1` and names the form via
  `aria-labelledby`). Keep it / Never mind / Cancel / Escape put focus back on the opener
  (`useFocusReturn`). Escape in the Edit box does nothing.
- **Keeping the owner's place (Check 9 P5):** queue forms carry hidden `threadId` /
  `nextThreadId` (`CardTargets`); actions redirect with `&t=<uuid>` — the same card for a
  refusal, save, quick change, hold or practice send; the next card (else the one before, else
  the card's own id so the URL still changes) for send, discard, snooze, "I called them",
  "They said no" / "Already paid". The `?done=` / `?error=` notice renders on that card when it's
  on the page, else at the top. Redirect URLs are built as `` `/queue?…${at(t)}` `` so the
  open-redirect scan still sees a literal `/queue` prefix. Next 16 does not apply a server-action
  redirect to the exact URL the page is on minus its `#t-…` hash — hence the own-id fallback.
  `ScrollToThread` skips "not on your queue" after a tap (`done`/`error`/`sent` and no hash).
- **After Send reply (Check 9 P5 + Check 32 P7):** the "reply on its way, squared away." box is a
  strip fixed above the phone tab bar (`SentStrip`); its line is the page's h1 (the queue
  heading is not rendered then); it takes focus once on mount (`preventScroll`), so the next Tab
  is Undo. `UndoSend` has one sr-only status: "You have 20 seconds to undo." (from
  `UNDO_WINDOW_SECONDS`), then "Time's up. Sending now." — the visible seconds are
  `aria-hidden`. (The spec said "Sent."; it isn't sent yet at that moment, so the words say
  what is true.)
- **Right now (Check 9 P6):** `queueMembership` returns `now` (emergencies with or without a
  draft: the lane, or high priority + needs the owner; never a check-in), a view onto
  `needsYou`/`drafts`, so every count is unchanged; both lists also sort emergencies first. A
  draft on an emergency thread now carries `lane` too. The queue's "Emergency" section is now
  "Right now" and holds draft cards as well.
- **Whole reply above Send reply (Check 9 P7):** a card with a Send reply button never folds the
  text; cards without one fold to 4 lines, and "Show full draft" shows only when the fold hides
  something (measured).
- **Once per card (Check 9 P12):** card header = tag + summary; the sorting reason lives in Why
  this? (shown on the card only when there's no summary); "Needs you: …" is skipped on a Right
  now card that has a summary; a reason's "Scheduling:"-style prefix is stripped
  (`withoutCategoryPrefix`, `src/lib/card-words.ts`). Remind me later and I called them share a
  row.
- **Draft a reply (Check 9 P9):** `DraftReplyButton` ("Writing a draft…", disabled, "This takes
  a few seconds. Nothing is sent."). `createDraftForThread` takes a 2-minute per-thread lease
  first (`src/server/draft-claims.ts`, rows `draft-claim:<threadId>` in `app_settings`, token
  only, purged daily), for every trigger; a second run returns `already_pending` before any
  Gmail read or model call. The tap that lost waits up to 25 s for the draft and then says
  "Reply drafted." (draft younger than a minute) or "Couldn't write a draft…".
- **Gaps (Check 9 P11 + Check 23 P8):** "Fill in N gaps to send" is a real button that opens the
  first gap's box (the open-gap state lives in `DraftCard`). Quick changes post the card's text
  (`body`) when gaps were filled; `reviseDraft({ currentBody })` uses it only when
  `filledGaps(saved, current)` (`src/ai/gaps.ts`) proves it is the saved text with gaps filled
  and nothing else changed; the typed values count as the owner's facts and instruction.
- **Warnings order (Check 23 P9):** `scoreDraft` (exported) orders fixed cautions, purpose flags,
  the code's check flags, then the model's notes; `capFlags` keeps 6, the last being "And N more
  things to check." when cut. After the one retry, `betterAttempt` keeps the attempt with fewer
  REGENERATE_ON hits (tie → retry) and logs `draft_retry_kept { kept }` only.
- **Getting started (Check 9 P13):** a finished list is one line ("You're all set up." + Hide);
  `business_profile.onboarding_done_at` is set the first time all steps are done (cleared if a
  step un-does) and the list hides itself 3 days later.
- **Swipe (Check 9 P14):** the discard countdown says "Discarding in 5 seconds. Undo to keep it."
  once (sr-only status; the ticking text is `aria-hidden`); dragging shows "Open" / "Discard" on
  the uncovered strip; a one-time tip on the first draft card on touch phones (localStorage
  `sa_swipe_tip_seen`, try/catch), placed under the buttons so it never pushes Send reply down.
- **Send together (Check 41 P2):** `namesAVisitTime` (`src/ai/draft-checks.ts`); a scheduling
  draft that names a day, date or time is never batch-eligible (`BatchCandidate.visitTime`);
  `/queue/review` shows one count-free line when any were held (`batchReview`).
- **Nudge cards (Check 21 P8):** Discard says it ends the chasing; "They said no" (quote →
  `setQuoteOutcome(lost)`) / "Already paid" (invoice → `setInvoicePaid(true)`) via
  `nudgeSaidNoAction` / `nudgeAlreadyPaidAction`; both close the nudge here and in Gmail.
- **Headings (Check 32 P9/P11):** each queue card's name is an h3 (draft cards: the article is
  named "<customer> · draft reply"; e2e selectors updated); Inbox rows' names are h2; names wrap
  (`break-words`) on Queue, Inbox, Quotes, Customers and Money.
- **Edit (Check 8 P7/P9):** cursor at the end; a divider and ≥24px before Send reply; on phones
  the tab bar hides (visibility) while a text field in `main` has focus, and returns 400 ms after it loses focus so a tap near the bottom lands on its button (theme.css). The To line, kind, "Wrote
  …", Money's invoice number and nudges line are 16px.
- **Words (Check 9 P15 / Check 48 P5):** "When Priya writes back, it shows up here."; busy: "That's
  a lot in a short time, so nothing was sent. Try again in a few minutes."; the Hold to talk note
  names Google, Apple or Microsoft (one company only for desktop Edge or Safari; the user agent
  is read in the browser only).

## Privacy policy line (Check 48 P5)

The policy says the voice feature's "speech service (run by Google or Apple…". Edge sends speech
to Microsoft. Suggested: "speech service (run by your browser's maker — Google, Apple or
Microsoft)". `tests/unit/legal-docs.test.ts:178` asserts the old words; update both together.

## Questions for Davi

1. **Check 9 P8 (not built):** show each reply's full text on Review all ready, with a tick box
   per row? It changes plan #5 ("recipient + first line"). Waiting for a yes.
2. **Check 41 P2:** the same "confirms a day or time → one at a time" rule could apply to
   autopilot's scheduling replies. Not changed; your call.
3. **Check 9 P9:** a background drafting job now also stands down while the owner's tap is
   writing the same thread (and the other way round). Safe default; say if you'd rather jobs
   always retry immediately.

## Integration notes

- Wave 2 groups that edit the same files: Inbox (`inbox/page.tsx` row heading), Quotes and Money
  (`quotes/page.tsx`, `money/page.tsx` class changes), Customers (`customer-list.tsx`), Phone
  look and accessibility (theme.css tab-bar rule, focus), Prompt versions (`drafts.ts`
  `scoreDraft` / retry), Follow-ups (nudge actions).
- `src/server/drafts.ts`: `createDraftForThread` is now a wrapper around
  `writeDraftForThread`; `listQueue` / `queueMembership` return `now`; `batchReview` added.
- The Inbox's own "Draft a reply" button doesn't have the working state yet (Inbox group's file).
