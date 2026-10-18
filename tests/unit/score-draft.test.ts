import { describe, expect, it } from "vitest";
import { capFlags, scoreDraft } from "@/server/drafts";

/** Check 23 P9: the code's warnings first; nothing dropped without saying so. */
const money = "Mentions $1,545 — that price isn't in the email or your profile. Check it.";
const modelNotes = ["Note one.", "Note two.", "Note three.", "Note four.", "Note five.", "Six."];

describe("Check 23 P9: scoreDraft", () => {
  it("six model notes plus one money flag: the money flag is shown", () => {
    const r = scoreDraft(
      { flags: modelNotes, confidence: 0.9 },
      { flags: [money], confidenceCap: 0.5, hits: ["money"] },
      [],
    );
    expect(r.flags[0]).toBe(money);
    expect(r.flags).toHaveLength(6);
    expect(r.flags.at(-1)).toBe("And 2 more things to check.");
    expect(r.confidence).toBe(50);
  });

  it("seven lines show five and 'And 2 more things to check.'", () => {
    const seven = ["a", "b", "c", "d", "e", "f", "g"].map((x) => `Line ${x}.`);
    expect(capFlags(seven)).toEqual([...seven.slice(0, 5), "And 2 more things to check."]);
    expect(capFlags(seven.slice(0, 6))).toEqual(seven.slice(0, 6));
    expect(capFlags(["Same.", "Same.", " Same. "])).toEqual(["Same."]);
  });

  it("order: fixed cautions, purpose flags, the code's checks, then the model's notes", () => {
    const r = scoreDraft(
      { flags: ["Model note."], confidence: 0.9 },
      { flags: ["Check A.", "Check B."], confidenceCap: 1, hits: [] },
      ["Purpose."],
      ["Fixed."],
    );
    expect(r.flags).toEqual(["Fixed.", "Purpose.", "Check A.", "Check B.", "Model note."]);
  });
});
