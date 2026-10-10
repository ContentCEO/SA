import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { businessProfiles, drafts, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { buildChecklist, checklistFor, dismissChecklist } from "@/server/onboarding";
import { createTestDb } from "../support/db";

describe("checklist rules", () => {
  const f = { mailboxes: 0, profileCompleted: false, draftsChecked: 0, dismissed: false };
  it("ticks each step from facts and stays until dismissed after all three", () => {
    expect(buildChecklist(f).steps.map((s) => s.done)).toEqual([false, false, false]);
    const done = { mailboxes: 1, profileCompleted: true, draftsChecked: 3, dismissed: false };
    expect(buildChecklist(done)).toMatchObject({ allDone: true, show: true });
    expect(buildChecklist({ ...done, dismissed: true }).show).toBe(false);
    // Dismissed earlier but a step became undone (Gmail disconnected): it comes back.
    expect(buildChecklist({ ...done, mailboxes: 0, dismissed: true }).show).toBe(true);
    expect(buildChecklist({ ...done, draftsChecked: 2 }).steps[2]).toMatchObject({
      done: false,
      detail: "2 of 3",
    });
  });
});

describe("checklist from the database", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "o@shop.com" });
    workspaceId = workspace.id;
    mailboxId = (
      await saveConnectedMailbox(workspace, {
        email: "o@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
  });

  async function draft(i: number, status: "pending" | "sent" | "discarded", edited = false) {
    const [t] = await database
      .insert(threads)
      .values({ mailboxId, gmailThreadId: `t${i}`, inInbox: true })
      .returning();
    await database.insert(drafts).values({
      threadId: t!.id,
      mailboxId,
      gmailDraftId: `d${i}`,
      toAddress: "c@x.com",
      subject: "Re",
      body: edited ? "changed" : "body",
      originalBody: "body",
      reason: "r",
      promptVersion: "draft.v3",
      status,
    });
  }

  it("counts sent, discarded and edited drafts; untouched ones don't count", async () => {
    await draft(1, "sent");
    await draft(2, "pending"); // untouched
    await draft(3, "pending", true); // edited
    let list = await checklistFor(workspaceId);
    expect(list.steps.map((s) => s.done)).toEqual([true, false, false]);
    expect(list.steps[2]!.detail).toBe("2 of 3");

    await draft(4, "discarded");
    await database.insert(businessProfiles).values({ workspaceId, completedAt: new Date() });
    list = await checklistFor(workspaceId);
    expect(list.allDone).toBe(true);
  });

  it("can't be hidden until every step is done", async () => {
    expect(await dismissChecklist(workspaceId)).toBe(false);
    for (const i of [1, 2, 3]) await draft(i, "sent");
    await database.insert(businessProfiles).values({ workspaceId, completedAt: new Date() });
    expect(await dismissChecklist(workspaceId)).toBe(true);
    expect((await checklistFor(workspaceId)).show).toBe(false);
    const [p] = await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId));
    expect(p!.onboardingDismissedAt).not.toBeNull();
  });
});
