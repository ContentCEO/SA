import { describe, expect, it } from "vitest";
import { workspaceBlock, type WorkspaceContext } from "@/ai/prompts/draft.v9";
import { businessProfiles, voiceProfiles } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { workspaceContext } from "@/server/drafts";
import { signatureWithoutSignoff } from "@/server/signature-rules";
import { createTestDb } from "../support/db";

/** Check 15 P6 + Check 24 P11: the sign-off is asked once and printed once. */
describe("signatureWithoutSignoff", () => {
  const sig = "Thanks, Mike\nRuiz Street Plumbing · (978) 555-0142";
  it("drops a first line that is the sign-off", () => {
    expect(signatureWithoutSignoff(sig, "Thanks, Mike")).toBe(
      "Ruiz Street Plumbing · (978) 555-0142",
    );
  });
  it("ignores case, spaces and trailing punctuation", () => {
    expect(signatureWithoutSignoff(sig, "thanks,  mike")).toBe(
      "Ruiz Street Plumbing · (978) 555-0142",
    );
    expect(signatureWithoutSignoff("\n  Thanks, Mike,\nRuiz", "Thanks, Mike")).toBe("Ruiz");
    expect(signatureWithoutSignoff("Thanks Mike!\nRuiz", "ThanksMike")).toBe("Ruiz");
  });
  it("keeps the signature when the first line is something else", () => {
    expect(signatureWithoutSignoff("Ruiz Street Plumbing\nThanks, Mike", "Thanks, Mike")).toBe(
      "Ruiz Street Plumbing\nThanks, Mike",
    );
    expect(signatureWithoutSignoff("Thanks, Michael\nRuiz", "Thanks, Mike")).toBe(
      "Thanks, Michael\nRuiz",
    );
  });
  it("an empty signature or sign-off", () => {
    expect(signatureWithoutSignoff(null, "Thanks, Mike")).toBeNull();
    expect(signatureWithoutSignoff("  ", "Thanks, Mike")).toBeNull();
    expect(signatureWithoutSignoff(sig, null)).toBe(sig);
    expect(signatureWithoutSignoff(sig, " ")).toBe(sig);
    expect(signatureWithoutSignoff("Thanks, Mike", "Thanks, Mike")).toBeNull();
  });
});

describe("the drafter's context", () => {
  it("gets the signature without the repeated sign-off; the saved one is unchanged", async () => {
    const database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "mike@ruiz.com" });
    await database.insert(businessProfiles).values({
      workspaceId: workspace.id,
      signature: "Thanks, Mike\nRuiz Street Plumbing · (978) 555-0142",
    });
    await database.insert(voiceProfiles).values({
      workspaceId: workspace.id,
      status: "ready",
      greetingStyle: null,
      signoffStyle: "Thanks, Mike",
    });
    const ctx = await workspaceContext(workspace.id, workspace);
    expect(ctx.signature).toBe("Ruiz Street Plumbing · (978) 555-0142");
    const block = workspaceBlock(ctx as WorkspaceContext);
    expect(block.match(/Thanks, Mike/g)).toHaveLength(1);
    // Check 24 P11: no greeting never prints "null".
    expect(block).not.toMatch(/Usual greeting: null/);
    expect(block).toContain("Usual greeting: not given");
    const [p] = await database.select().from(businessProfiles);
    expect(p!.signature).toBe("Thanks, Mike\nRuiz Street Plumbing · (978) 555-0142");
  });
});
