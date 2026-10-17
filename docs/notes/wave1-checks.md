# wave1-checks (wave 1, group "Draft checks")

Notes for the integrator: what CLAUDE.md should say, by step. Files in this group's area:
`src/ai/draft-checks.ts`, `src/ai/money-words.ts`, plus the new `src/ai/when-words.ts`.

## CLAUDE.md, under Decisions

- **Days and times as whole words (Check 20 P1 + 23 P3 + 23 P4, wave 1):** `src/ai/when-words.ts`
  (pure). `normalizeWhen` writes days, dates and times one way ("Fri" → friday, "8 a.m." → 8am,
  "Nov 27th" → november 27, "Mon–Fri" / "weekdays" → each day; "Sat", "Sun", "Wed" only when
  capitalised, since they are everyday words) and `whenTokens` turns them into keys; the check
  compares keys, never substrings ("fridge" no longer excuses "Fri"). New sources in
  `CheckContext`: `whenSourceText` (the conversation, seasonal notes **and their end dates**
  written "November 27", the owner's instruction / spoken words / a clean earlier draft — never
  the hours, lead time or policies), `hoursText` (its times always count; its days only with
  `allowHours`: the "Add my availability" tweak, or the customer asked when the owner is open,
  `asksWhenAvailable`), `leadTimeText` (only its "two weeks out" wording counts). Times now include
  "at 9", "around 8", "9:30", "9 o'clock", "10 a.m.", "in the morning"; loose timing adds "within
  the hour", "before the day is out", "by tonight", holidays as deadlines ("before Thanksgiving";
  any mention of the holiday in the conversation allows it), lead times ("three weeks out",
  "booked up through …"). A "today"/"tonight"/"tomorrow" whose only source is a customer email
  from an earlier local day gets "Says “tomorrow”, but they wrote that on Tuesday. Check the day."
  A never-promise item about same-day work is broken by "today", "tonight", "within the hour" or
  "before the day is out". Built in `whenContext()` in `src/server/drafts.ts` for new drafts and
  revisions. "This coming Friday" reads as Friday (the day token covers it).
