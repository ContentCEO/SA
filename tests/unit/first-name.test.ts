import { describe, expect, it } from "vitest";
import { describeActivity } from "@/server/activity";
import { firstNameOf } from "@/lib/first-name";

describe("firstNameOf (Check 14 P10)", () => {
  it.each([
    ["Smith, Dana", "Dana"],
    ["dana.ruiz@gmail.com", null],
    ["Dr. Ana Ruiz", "Ana"],
    ["Dr Ana Ruiz", "Ana"],
    ["The Home Depot Pro", null],
    ["Chelmsford Building Dept", null],
    ["Kevin O'Connor", "Kevin"],
    ["ANA", "ANA"],
    ['"Dana Ruiz"', "Dana"],
    ["Ana Maria de la Cruz Ruiz", null],
    ["  ", null],
  ])("%s → %s", (name, first) => {
    expect(firstNameOf(name)).toBe(first);
  });

  it("null stays null", () => {
    expect(firstNameOf(null)).toBeNull();
    expect(firstNameOf(undefined)).toBeNull();
  });

  it("Activity uses it: no surname, address, title or business word as a name", () => {
    const who = (name: string) => ({ name, category: null });
    expect(describeActivity("draft_created", {}, who("Smith, Dana"))).toBe(
      "Drafted a reply to Dana",
    );
    expect(describeActivity("reply_sent", {}, who("dana.ruiz@gmail.com"))).toBe("You sent a reply");
    expect(describeActivity("draft_created", {}, who("Chelmsford Building Dept"))).toBe(
      "Drafted a reply",
    );
  });
});
