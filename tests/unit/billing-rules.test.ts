import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETUP_CALL_COVERS, setupCallSentence } from "@/server/billing-rules";

const flat = (s: string) => s.replace(/\s+/g, " ");

/** Check 35 P3: what the one-time setup covers, said one way in every place. */
describe("the setup call sentence", () => {
  for (const kind of ["before", "after"] as const) {
    it(`"${kind}" names every item, in order, and ends the same way`, () => {
      const s = setupCallSentence(kind);
      let at = -1;
      for (const item of SETUP_CALL_COVERS) {
        const i = s.indexOf(item);
        expect(i, item).toBeGreaterThan(at);
        at = i;
      }
      expect(s).toMatch(/your drafts until they sound like you$/);
      expect(s).not.toContain("scheduling");
    });
  }

  it("the homepage and /billing use it before paying; /billing and the banner after", () => {
    expect(readFileSync("src/app/page.tsx", "utf8")).toContain(
      'A call with us to {setupCallSentence("before")}.',
    );
    const billing = flat(readFileSync("src/app/(app)/billing/page.tsx", "utf8"));
    expect(billing).toContain('a call with us to {setupCallSentence("before")}.');
    expect(billing).toContain('On the call, {davi} {setupCallSentence("after")}.');
    const banner = flat(readFileSync("src/components/app/status-banner.tsx", "utf8"));
    expect(banner).toContain('{setupCallSentence("after")}');
    expect(banner).not.toContain("scheduling and never-promise list");
  });
});
