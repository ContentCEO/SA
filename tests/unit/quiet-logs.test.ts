import { describe, expect, it } from "vitest";
import { heldForThisTest } from "../support/setup";

/**
 * Check 31 P7: tests/support/setup.ts holds metadata lines ("ai_call", job tags) and prints them
 * only when the test fails. Checked through the real wrapper: console.info is what the model
 * client calls.
 */
describe("metadata log lines in tests", () => {
  it("a tagged line is held for the test, an ordinary one isn't", () => {
    console.info("ai_call", { promptVersion: "x", tokens: 1 });
    console.log("sync_done", { mailboxId: "m1" });
    console.info("Plain words, not a tag");
    expect(heldForThisTest().map(([, args]) => args[0])).toEqual(["ai_call", "sync_done"]);
  });

  it("each test starts with nothing held", () => {
    expect(heldForThisTest()).toEqual([]);
  });
});
