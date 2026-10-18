import { describe, expect, it } from "vitest";
import { describeActivity } from "@/server/activity";
import { recordClosingLine, whoOkayedLine } from "@/server/send-record-rules";

/** Check 42 P5: the record and Activity say only what the app knows. */
describe("send record wording (Check 42 P5)", () => {
  const me = "mike@shop.com";

  it("an app tap names the sign-in, never a person", () => {
    expect(whoOkayedLine("you", me)).toBe("Your sign-in (mike@shop.com)");
    expect(recordClosingLine("you", me)).toBe(
      "This is the record of the tap made while signed in as mike@shop.com. Anyone who uses this sign-in can okay replies.",
    );
    expect(whoOkayedLine("you", null)).toBe("Your sign-in");
  });

  it("a Gmail send is outside the app, with no claim about who", () => {
    expect(whoOkayedLine("you_in_gmail", me)).toBe("Sent from Gmail, outside the app");
    expect(recordClosingLine("you_in_gmail", me)).not.toMatch(/\bYou\b|signed in as/);
  });

  it("autopilot is unchanged", () => {
    expect(whoOkayedLine("autopilot", me)).toBe(
      "Autopilot — you switched it on for this kind of email",
    );
  });

  it("no line claims to be proof of who tapped", () => {
    for (const by of ["you", "you_in_gmail", "autopilot"] as const)
      expect(`${whoOkayedLine(by, me)} ${recordClosingLine(by, me)}`).not.toMatch(
        /proof|without your okay/i,
      );
  });

  it("Activity: a draft sent from Gmail is described as outside the app", () => {
    expect(
      describeActivity("reply_sent_from_gmail", {}, { name: "Dana Ruiz", category: null }),
    ).toBe("The draft to Dana was sent from Gmail, outside the app");
    expect(describeActivity("reply_sent_from_gmail", {}, null)).toBe(
      "The draft was sent from Gmail, outside the app",
    );
  });
});
