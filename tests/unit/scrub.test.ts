import { describe, expect, it } from "vitest";
import { SCRUB_RULES, scrubAllowFrom, scrubText } from "@/server/scrub";

/**
 * Check 24 P4: every detail the review's script found the old scrub missing, each inside an
 * owner-style sentence. Invented (example.com, 555 numbers).
 */
const MUST_GO: [string, string, string][] = [
  // [sentence, the detail, the token it becomes]
  ["It'll run about 1.2k for the whole job.", "1.2k", "[price]"],
  ["Figure 4.5K with materials.", "4.5K", "[price]"],
  ["I can do it for twelve hundred.", "twelve hundred", "[price]"],
  ["Call it 1,200 bucks and we're good.", "1,200 bucks", "[price]"],
  ["The fixture is 150$ installed.", "150$", "[price]"],
  ["Son 450 dólares con material.", "450 dólares", "[price]"],
  ["Pavers run 18.50 ea.", "18.50 ea", "[price]"],
  ["My rate is 85/hr for service calls.", "85/hr", "[price]"],
  ["Tile is 9.75/sq ft installed.", "9.75/sq ft", "[price]"],
  ["About $1.2k all in.", "$1.2k", "[price]"],
  ["Deposit is $450 up front.", "$450", "[price]"],
  ["Roughly five grand for the deck.", "five grand", "[price]"],
  ["Total comes to 2,400 dollars.", "2,400 dollars", "[price]"],
  ["Fica 900 reais.", "900 reais", "[price]"],
  ["It's 12 per sq ft for the floor.", "12 per sq ft", "[price]"],
  ["I'll be at 45 maple st around 8.", "45 maple st", "[address]"],
  ["Mail the check to P.O. Box 312.", "P.O. Box 312", "[address]"],
  ["Send it to Lowell, MA 01824 please.", "01824", "[address]"],
  ["Meet me at Unit 4B by the elevator.", "Unit 4B", "[address]"],
  ["The shop is at 88 Route 110 now.", "88 Route 110", "[address]"],
  ["Pick up at 7 Hwy 3A after lunch.", "7 Hwy 3A", "[address]"],
  ["We're working at 14 Orchard Pl this week.", "14 Orchard Pl", "[address]"],
  ["Next job is 9 Birch Terrace.", "9 Birch Terrace", "[address]"],
  ["Drop the tile at 3 Hill Cir.", "3 Hill Cir", "[address]"],
  ["C'est au 1520 Rue Sainte-Catherine Ouest.", "1520 Rue Sainte-Catherine Ouest", "[address]"],
  ["Code postal H3G 1N4.", "H3G 1N4", "[address]"],
  ["Estoy en Calle Principal 45 mañana.", "Calle Principal 45", "[address]"],
  ["We finished 12 Elm Street on Friday.", "12 Elm Street", "[address]"],
  ["Text me https://wa.me/19785550142 anytime.", "19785550142", "[phone]"],
  ["Tap tel:+19785550142 to call.", "+19785550142", "[phone]"],
  ["My cell is 978 555 01 42.", "978 555 01 42", "[phone]"],
  ["Call the office at 555-0142.", "555-0142", "[phone]"],
  ["Reach me at (978) 555-0142.", "(978) 555-0142", "[phone]"],
  ["Or 1-978-555-0142 after 5.", "1-978-555-0142", "[phone]"],
  ["Email dana at example dot com with photos.", "dana at example dot com", "[email]"],
  ["Email dana.ruiz@example.com with photos.", "dana.ruiz@example.com", "[email]"],
];

describe("scrubText (Check 24 P4)", () => {
  for (const [sentence, detail, token] of MUST_GO) {
    it(`replaces ${detail}`, () => {
      const out = scrubText(sentence);
      expect(out).not.toContain(detail);
      expect(out).toContain(token);
    });
  }

  it("keeps invoice and serial numbers", () => {
    expect(scrubText("Invoice 2026101400 is attached.")).toBe("Invoice 2026101400 is attached.");
    expect(scrubText("The heater serial is RH-1234567890.")).toBe(
      "The heater serial is RH-1234567890.",
    );
    expect(scrubText("Permit # 2026-0042 passed.")).toBe("Permit # 2026-0042 passed.");
  });

  it("leaves ordinary sentences alone", () => {
    for (const s of [
      "I can swing by Tuesday around 8.",
      "I'll put 2 coats on the way out.",
      "Sounds good, see you at 7:30.",
      "We need 3 more days on the kitchen.",
      "Hey [name], thanks for reaching out!",
    ])
      expect(scrubText(s)).toBe(s);
  });

  it("lets the business's own phone and website stay", () => {
    const allow = scrubAllowFrom("Mike Doyle\nDoyle Electric\n978-555-0100\nwww.doyle-example.com");
    expect(allow.phones).toEqual(["9785550100"]);
    expect(allow.hosts).toContain("doyle-example.com");
    expect(scrubText("Call me at 978-555-0100 or see doyle-example.com.", allow)).toBe(
      "Call me at 978-555-0100 or see doyle-example.com.",
    );
    expect(scrubText("Write to office@doyle-example.com.", allow)).toBe(
      "Write to office@doyle-example.com.",
    );
    expect(scrubText("Her cell is 978-555-0177.", allow)).toBe("Her cell is [phone].");
  });

  it("every rule has a name and a token", () => {
    for (const r of SCRUB_RULES) {
      expect(r.name).toMatch(/^[a-z_]+$/);
      expect(r.re.flags).toContain("g");
    }
  });
});
