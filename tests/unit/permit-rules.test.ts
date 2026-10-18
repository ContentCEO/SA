import { describe, expect, it } from "vitest";
import { carryPermitFacts, permitOf, type PermitFacts } from "@/server/permit-rules";

const failed: PermitFacts = {
  issuing_body: "Town of Westford Building Dept.",
  permit_number: "E-26-0412",
  inspection_at: null,
  result: "failed",
  corrections: [
    "Bonding jumper at water meter missing",
    "AFCI protection missing on bedroom circuits",
    "Box fill exceeded",
  ],
};
const next = (p: Partial<PermitFacts>): PermitFacts => ({
  issuing_body: "Town of Westford Building Dept.",
  permit_number: "E-26-0412",
  inspection_at: null,
  result: "other",
  corrections: [],
  ...p,
});

describe("carryPermitFacts (Check 37 P2)", () => {
  it("failed then re-inspection scheduled keeps the fix list", () => {
    const r = carryPermitFacts(
      failed,
      next({ result: "scheduled", inspection_at: "Thursday 10/23 9-11" }),
    );
    expect(r).toEqual({
      ...failed,
      result: "scheduled",
      inspection_at: "Thursday 10/23 9-11",
    });
  });
  it("failed then passed clears the fix list", () => {
    expect(carryPermitFacts(failed, next({ result: "passed" }))?.corrections).toEqual([]);
  });
  it("new corrections replace the old list", () => {
    expect(
      carryPermitFacts(failed, next({ result: "failed", corrections: ["Label the panel"] }))
        ?.corrections,
    ).toEqual(["Label the panel"]);
  });
  it("a missing number on one side with the same issuing body is the same permit", () => {
    const r = carryPermitFacts(failed, next({ permit_number: null, result: "scheduled" }));
    expect(r?.permit_number).toBe("E-26-0412");
    expect(r?.corrections).toHaveLength(3);
  });
  it("a new permit number replaces everything", () => {
    const other = next({ permit_number: "B-26-0099", result: "scheduled" });
    expect(carryPermitFacts(failed, other)).toEqual(other);
  });
  it("nothing about a permit keeps what's stored", () => {
    expect(carryPermitFacts(failed, null)).toEqual(failed);
    expect(carryPermitFacts(null, null)).toBeNull();
  });
  it("permitOf reads only well-formed facts (and a purged fix list as empty)", () => {
    expect(permitOf({ permit: { ...failed, corrections: undefined } })?.corrections).toEqual([]);
    expect(permitOf({ permit: null })).toBeNull();
    expect(permitOf(null)).toBeNull();
  });
});
