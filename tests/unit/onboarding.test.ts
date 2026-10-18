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

describe("Check 9 P13: a finished list folds, then goes by itself", () => {
  const done = { mailboxes: 1, profileCompleted: true, draftsChecked: 3, dismissed: false };
  const now = new Date("2026-10-17T12:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  it("all done today → shown (as one line); 4 days ago → hidden; a step un-done → full list", () => {
    expect(buildChecklist({ ...done, doneAt: now, now })).toMatchObject({
      allDone: true,
      show: true,
    });
    expect(buildChecklist({ ...done, doneAt: daysAgo(2.9), now }).show).toBe(true);
    expect(buildChecklist({ ...done, doneAt: daysAgo(4), now }).show).toBe(false);
    const undone = buildChecklist({ ...done, mailboxes: 0, doneAt: daysAgo(4), now });
    expect(undone).toMatchObject({ allDone: false, show: true });
  });

  it("one line when all done: the heading and a small Hide, no steps", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { OnboardingChecklist } = await import("@/components/app/onboarding-checklist");
    const html = renderToStaticMarkup(
      createElement(OnboardingChecklist, {
        list: buildChecklist({ ...done, doneAt: now, now }),
        dismissAction: async () => {},
      }),
    ).replace(/&#x27;/g, "'");
    expect(html).toContain("You're all set up.");
    expect(html).toContain(">Hide</button>");
    expect(html).not.toContain("<ol");
    expect(html).not.toContain("Connect Gmail");
  });

  it("the database remembers when it was first all done, and forgets it if a step un-does", async () => {
    const database = await createTestDb();
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    const { workspace } = await ensureUserAndWorkspace({ email: "p@shop.com" });
    const box = await saveConnectedMailbox(workspace, {
      email: "p@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    await database.insert(businessProfiles).values({ workspaceId: workspace.id, completedAt: now });
    for (let i = 0; i < 3; i++) {
      const [t] = await database
        .insert(threads)
        .values({ mailboxId: box.id, gmailThreadId: `p${i}`, inInbox: true })
        .returning();
      await database.insert(drafts).values({
        threadId: t!.id,
        mailboxId: box.id,
        gmailDraftId: `pd${i}`,
        toAddress: "c@x.com",
        subject: "Re",
        body: "body",
        originalBody: "body",
        reason: "r",
        promptVersion: "draft.v8",
        status: "sent",
      });
    }
    const doneAt = async () =>
      (
        await database
          .select({ at: businessProfiles.onboardingDoneAt })
          .from(businessProfiles)
          .where(eq(businessProfiles.workspaceId, workspace.id))
      )[0]!.at;
    expect((await checklistFor(workspace.id, { now })).show).toBe(true);
    expect(await doneAt()).toEqual(now);
    // A later visit keeps the first time; four days on it's gone.
    await checklistFor(workspace.id, { now: daysAgo(-1) });
    expect(await doneAt()).toEqual(now);
    expect((await checklistFor(workspace.id, { now: daysAgo(-4) })).show).toBe(false);
    // A step un-does (the profile is reset): the full list is back and the clock is cleared.
    await database.update(businessProfiles).set({ completedAt: null });
    const back = await checklistFor(workspace.id, { now: daysAgo(-5) });
    expect(back).toMatchObject({ allDone: false, show: true });
    expect(await doneAt()).toBeNull();
  });
});
