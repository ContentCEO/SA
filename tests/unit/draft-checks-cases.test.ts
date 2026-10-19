/**
 * Check 23 P12 (wave 2, Prompt versions step 9): one row per example, flagged or clean, through
 * the same check context the app builds (`buildCheckContext`), so a later regex edit can't
 * quietly undo another fix. A sample plumbing profile. Rows for checks that aren't built yet are
 * `it.todo` (listed in docs/notes/w2-prompts.md).
 */
import { describe, expect, it } from "vitest";
import { checkDraft } from "@/ai/draft-checks";
import { buildCheckContext, type DraftContext } from "@/server/drafts";

const NOW = new Date("2026-10-14T15:00:00Z");
const PROFILE: DraftContext = {
  businessName: "Ruiz Street Plumbing",
  trade: "plumbing",
  services: "Leaks, water heaters, drain clearing.",
  serviceArea: null,
  hours: "Mon–Fri 7am–4pm",
  leadTime: "About two weeks out",
  pricingNotes:
    "Water heater swap, 40 gal tank: from $1,450 installed\nService call: $95, put toward the job",
  paymentTerms: "Due on receipt. Check or card.",
  policies: null,
  signature: "Mike",
  doNotPromise: [],
  neverSay: ["hun"],
  seasonalNotes: [{ text: "Booked until Nov 27", endsOn: "2026-11-27" }],
  voice: null,
  licenses: {},
  reviewUrl: null,
  timeZone: "America/New_York",
};

function check(body: string, customer: string, ownerNote: string | null = null) {
  return checkDraft(
    body,
    buildCheckContext({
      ctx: PROFILE,
      conversation: [
        { m: { direction: "in", sentAt: new Date(NOW.getTime() - 3_600_000) }, text: customer },
      ],
      ownerNote,
      now: NOW,
      knownNames: ["Dana Ruiz"],
    }),
  );
}

const ASK = "Hi, our water heater is leaking. Can you replace it, and when could you come?";

/** [draft sentence, the customer's email, built today?] */
const SHOULD_FLAG: [string, string, boolean][] = [
  ["ballpark 3-4k depending on access", ASK, true],
  // Not built: a spoken figure that matches the list's $1,450 but drops its "from" (the price
  // list check reads "$1,450" and "1450", not number words).
  ["it's fourteen fifty for the swap", ASK, false],
  ["usually low four figures", ASK, true],
  ["I can come Fri", "The fridge in the garage is leaking water too.", true],
  ["I could swing by Sat morning", "We were really satisfied last time.", true],
  ["I'll be there at 10 a.m.", ASK, true],
  ["I can be there within the hour", ASK, true],
  ["We'll have it done before Thanksgiving", ASK, true],
  ["We're about three weeks out", ASK, true],
  ["No permit needed for that one", ASK, true],
  ["It's all up to code", ASK, true],
  ["That's covered under warranty", "Is that covered under warranty?", true],
  ["I'll waive the trip fee", ASK, true],
  ["We'll match their price", "Another company quoted $1,200.", true],
  ["We just need half down to start", ASK, true],
  ["Net 30 is fine", ASK, true],
  ["Venmo works fine", "Can I pay by Venmo?", true],
  ["Call me at 978-555-0142", ASK, true],
  ["Book here: https://exampleplumbing.test/book", ASK, true],
  ["My guy Pete will handle it", ASK, true],
  ["Hi [name], thanks for the note", ASK, true],
  ["Thanks for reaching out", ASK, true],
];

const SHOULD_PASS: [string, string, string | null, boolean][] = [
  ["Monday or Tuesday works", "Could you come Monday or Tuesday?", null, true],
  ["8 am Thursday works", "Can you come 8am Thursday?", null, true],
  ["We're booked until Nov 27", ASK, null, true],
  ["I'll hunt down the right flapper", ASK, null, true],
  ["A 40 gal tank swap is from $1,450 installed", ASK, null, true],
  ["The disposal swap is $450", ASK, "tell her Thursday works, 450", true],
  ["Sorry for the delay", ASK, null, true],
];

describe("draft checks, one row per example (Check 23 P12)", () => {
  for (const [body, customer, built] of SHOULD_FLAG) {
    if (!built) {
      it.todo(`flags: ${body}`);
      continue;
    }
    it(`flags: ${body}`, () => {
      expect(check(body, customer).flags.length, body).toBeGreaterThan(0);
    });
  }
  for (const [body, customer, note, built] of SHOULD_PASS) {
    if (!built) {
      it.todo(`passes: ${body}`);
      continue;
    }
    it(`passes: ${body}`, () => {
      expect(check(body, customer, note).flags, body).toEqual([]);
    });
  }
});
