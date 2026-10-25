import { describe, expect, it } from "vitest";
import { ownWords, splitOwnWords, wordCount } from "@/server/voice-text";

/**
 * Check 24 P2: 36 invented sent emails (example.com addresses, 555 numbers). Everything the
 * customer wrote carries a CUSTOMER-xx marker plus their street, cell and address; none of it may
 * reach the voice prompt, and the owner's own phrases must.
 */
const customer = (n: number) =>
  `CUSTOMER-${String(n).padStart(2, "0")} Hi, we live at 45 Maple Street and want the deck redone. My cell is 978-555-0177. Dana Ruiz dana.ruiz@example.com`;
const CUSTOMER_DETAILS = ["45 Maple Street", "978-555-0177", "dana.ruiz@example.com", "Dana Ruiz"];

type Case = { name: string; body: string; keep: string[]; gone?: string[]; forward?: boolean };

const quoted = (n: number) =>
  customer(n)
    .split(". ")
    .map((l) => `> ${l}`)
    .join("\n");

const outlookBlock = (n: number, subject = "RE: Deck") =>
  `From: Dana Ruiz <dana.ruiz@example.com>\nSent: Tuesday, October 14, 2026 3:12 PM\nTo: Mike Doyle <mike@doyle-example.com>\nSubject: ${subject}\n\n${customer(n)}`;

const CASES: Case[] = [
  {
    name: "Gmail one-line header",
    body: `I can swing by Thursday at 8.\n\nOn Tue, Oct 14, 2026 at 3:12 PM Dana Ruiz <dana.ruiz@example.com> wrote:\n${quoted(1)}`,
    keep: ["I can swing by Thursday at 8."],
  },
  {
    name: "Gmail wrapped header",
    body: `Sounds good, see you then.\n\nOn Tue, Oct 14, 2026 at 3:12 PM Dana Ruiz <dana.ruiz@example.com>\nwrote:\n\n${quoted(2)}`,
    keep: ["Sounds good, see you then."],
  },
  {
    name: "Gmail header wrapped inside the address",
    body: `Works for me.\n\nOn Tue, Oct 14, 2026 at 3:12 PM Dana Ruiz <\ndana.ruiz@example.com> wrote:\n${quoted(3)}`,
    keep: ["Works for me."],
  },
  {
    name: "Spanish header",
    body: `Paso el jueves a las 8.\n\nEl mar, 14 oct 2026 a las 15:12, Dana Ruiz escribió:\n${quoted(4)}`,
    keep: ["Paso el jueves a las 8."],
  },
  {
    name: "Spanish header starting with On",
    body: `Claro que sí, el lunes.\n\nOn mar, 14 oct 2026, Dana Ruiz <dana.ruiz@example.com> escribió:\n${quoted(5)}`,
    keep: ["Claro que sí, el lunes."],
  },
  {
    name: "Portuguese header (Em …)",
    body: `Combinado, até sexta.\n\nEm ter., 14 de out. de 2026 às 15:12, Dana Ruiz <dana.ruiz@example.com> escreveu:\n${quoted(6)}`,
    keep: ["Combinado, até sexta."],
  },
  {
    name: "Portuguese header",
    body: `Posso ir na quinta.\n\nOn ter., 14 de out. de 2026 às 15:12, Dana Ruiz <dana.ruiz@example.com> escreveu:\n${quoted(6)}`,
    keep: ["Posso ir na quinta."],
  },
  {
    name: "French header",
    body: `Je passe jeudi.\n\nLe mar. 14 oct. 2026 à 15:12, Dana Ruiz <dana.ruiz@example.com> a écrit :\n${quoted(7)}`,
    keep: ["Je passe jeudi."],
  },
  {
    name: "Outlook desktop reply",
    body: `Hi Dana, I can price that out this week.\n\nMike\n\n________________________________\n${outlookBlock(8)}`,
    keep: ["I can price that out this week."],
  },
  {
    name: "Outlook for iPhone reply",
    body: `Yep, Monday works.\n\nGet Outlook for iOS\n________________________________\n${outlookBlock(9)}`,
    keep: ["Yep, Monday works."],
    gone: ["Get Outlook"],
  },
  {
    name: "Outlook block without the underscore rule",
    body: `Got it, thanks.\n\n${outlookBlock(10)}`,
    keep: ["Got it, thanks."],
  },
  {
    name: "Outlook block with Date: instead of Sent:",
    body: `I'll call you tomorrow.\n\nFrom: Dana Ruiz <dana.ruiz@example.com>\nDate: Tuesday, October 14, 2026\nTo: Mike\nSubject: Re: Deck\n\n${customer(11)}`,
    keep: ["I'll call you tomorrow."],
  },
  {
    name: "Original Message",
    body: `We can start the 20th.\n\n-----Original Message-----\n${outlookBlock(12)}`,
    keep: ["We can start the 20th."],
  },
  {
    name: "Gmail forward with a note",
    body: `Tony, can you take this one on Friday? Bring the long ladder.\n\n---------- Forwarded message ---------\nFrom: Dana Ruiz <dana.ruiz@example.com>\nDate: Tue, Oct 14, 2026 at 3:12 PM\nSubject: Deck\nTo: <mike@doyle-example.com>\n\n${customer(13)}`,
    keep: ["can you take this one on Friday? Bring the long ladder."],
    forward: true,
  },
  {
    name: "Apple Mail forward",
    body: `Tony — this is the deck job I mentioned, can you look Monday?\n\nBegin forwarded message:\n\nFrom: Dana Ruiz <dana.ruiz@example.com>\nSubject: Deck\nDate: October 14, 2026 at 3:12:00 PM EDT\n\n${customer(14)}`,
    keep: ["this is the deck job I mentioned"],
    forward: true,
  },
  {
    name: "Bare forward",
    body: `FYI\n\n---------- Forwarded message ---------\nFrom: Dana Ruiz <dana.ruiz@example.com>\n\n${customer(15)}`,
    keep: ["FYI"],
    forward: true,
  },
  {
    name: "Outlook forward (FW:)",
    body: `See below.\n\n________________________________\n${outlookBlock(16, "FW: Deck")}`,
    keep: ["See below."],
    forward: true,
  },
  {
    name: "The owner's own 'On Friday the inspector wrote:'",
    body: `Hi Dana,\n\nOn Friday the inspector wrote:\nneeds a GFCI by the sink and a cover on the box in the attic. I'll fix both Monday.\n\nThanks, Mike`,
    keep: ["On Friday the inspector wrote:", "needs a GFCI by the sink", "I'll fix both Monday"],
  },
  {
    name: "Line starting On without a header",
    body: `On Monday I can come by around 9.\nOn Tuesday I'm booked.`,
    keep: ["On Monday I can come by around 9.", "On Tuesday I'm booked."],
  },
  {
    name: "Gmail header without a year",
    body: `See you at 8.\n\nOn Tue at 3:12 PM, Dana wrote:\n${quoted(19)}`,
    keep: ["See you at 8."],
  },
  {
    name: "Header with nothing after it",
    body: `Thanks, will do.\n\nOn Mon, Dana Ruiz wrote:`,
    keep: ["Thanks, will do."],
    gone: ["Dana Ruiz"],
  },
  {
    name: "Interleaved answers",
    body: `> CUSTOMER-21 Can you do Tuesday?\nTuesday is fine.\n> CUSTOMER-21 And 45 Maple Street has parking out back\nGreat, I'll park there.`,
    keep: ["Tuesday is fine.", "Great, I'll park there."],
  },
  {
    name: "Sent from my iPhone",
    body: `On my way, 10 minutes out.\n\nSent from my iPhone`,
    keep: ["On my way, 10 minutes out."],
    gone: ["Sent from my iPhone"],
  },
  {
    name: "Sent from my iPad and Galaxy footers",
    body: `I'll send the quote tonight.\n\nSent from my iPad\nSent from my Galaxy`,
    keep: ["I'll send the quote tonight."],
    gone: ["iPad", "Galaxy"],
  },
  {
    name: "Get Outlook for Android",
    body: `Materials are in.\n\nGet Outlook for Android`,
    keep: ["Materials are in."],
    gone: ["Outlook"],
  },
  {
    name: "Sent from Yahoo Mail",
    body: `Invoice is attached.\n\nSent from Yahoo Mail on Android`,
    keep: ["Invoice is attached."],
    gone: ["Yahoo"],
  },
  {
    name: "Sent from Mail for Windows",
    body: `No problem at all.\n\nSent from Mail for Windows`,
    keep: ["No problem at all."],
    gone: ["Windows"],
  },
  {
    name: "Yes plus a phone footer",
    body: `Yes\n\nSent from my iPhone`,
    keep: ["Yes"],
    gone: ["iPhone"],
  },
  {
    name: "Sounds good",
    body: `Sounds good`,
    keep: ["Sounds good"],
  },
  {
    name: "RFC signature",
    body: `Panel swap is done, all tested.\n\nThanks,\nMike\n-- \nMike Doyle\nDoyle Electric\nLic #E-12345\n978-555-0100`,
    keep: ["Panel swap is done, all tested.", "Thanks,\nMike"],
    gone: ["E-12345", "978-555-0100"],
  },
  {
    name: "Signature block with license and phone",
    body: `I can be there Wednesday morning.\n\nThanks,\nMike Doyle\nDoyle Electric\nLic. #12345\n(978) 555-0100`,
    keep: ["I can be there Wednesday morning.", "Thanks,"],
    gone: ["12345", "555-0100"],
  },
  {
    name: "Signature with a website",
    body: `Quote attached, let me know.\n\nBest,\nMike\nwww.doyle-example.com\nOffice: 978-555-0100`,
    keep: ["Quote attached, let me know.", "Best,"],
    gone: ["doyle-example.com", "555-0100"],
  },
  {
    name: "Massachusetts HIC signature",
    body: `We'll start demo Monday.\n\nMike\nHIC #198765\nCSL 104567`,
    keep: ["We'll start demo Monday.", "Mike"],
    gone: ["198765", "104567"],
  },
  {
    name: "Short note whose phone is part of the sentence",
    body: `I'll be there at 8, call me at 978-555-0100 if you're running late.\nMike`,
    keep: ["I'll be there at 8, call me at"],
  },
  {
    name: "Plain email, no quote",
    body: `Hi Dana,\n\nThe tile came in today. I'll start Monday at 7 and should be done by Wednesday.\n\nThanks,\nMike`,
    keep: ["The tile came in today.", "should be done by Wednesday.", "Thanks,\nMike"],
  },
  {
    name: "Windows line endings",
    body: `All set for Friday.\r\n\r\nOn Tue, Oct 14, 2026 at 3:12 PM Dana Ruiz <dana.ruiz@example.com> wrote:\r\n${quoted(36).replace(/\n/g, "\r\n")}`,
    keep: ["All set for Friday."],
  },
];

describe("ownWords: only the owner's own words reach voice learning (Check 24 P2)", () => {
  it("has 36 cases", () => expect(CASES).toHaveLength(36));

  for (const c of CASES) {
    it(c.name, () => {
      const { text, forward } = splitOwnWords(c.body);
      for (const k of c.keep) expect(text).toContain(k);
      expect(text).not.toMatch(/CUSTOMER-\d\d/);
      for (const g of [...CUSTOMER_DETAILS, ...(c.gone ?? [])]) expect(text).not.toContain(g);
      expect(forward).toBe(c.forward ?? false);
    });
  }

  it("counts words, not punctuation", () => {
    expect(wordCount("Sounds good")).toBe(2);
    expect(wordCount("Yes")).toBe(1);
    expect(wordCount(" — ")).toBe(0);
    expect(ownWords("Sent from my iPhone")).toBe("");
  });
});
