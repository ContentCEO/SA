import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import {
  activityLog,
  drafts,
  messages,
  threads,
  usage,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { adminOverview, isAdminEmail } from "@/server/admin";
import { classifyPending } from "@/server/classification";
import {
  createDraftForThread,
  discardDraft,
  reconcileDrafts,
  saveDraftEdit,
  sendDraft,
} from "@/server/drafts";
import {
  canMakeMove,
  canSend,
  effectiveStatus,
  evaluationClock,
  isReadOnly,
  jobsAllowed,
  ReadOnlyError,
  resumeTarget,
  SendingBlockedError,
  timeLeft,
} from "@/server/lifecycle";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { incrementalSync, listSyncableMailboxes } from "@/server/sync";
import { learnVoice, workspacesDueForVoiceRefresh } from "@/server/voice";
import {
  applyAdminMove,
  expireEvaluations,
  MoveNotAllowedError,
  startEvaluation,
  startPendingEvaluations,
} from "@/server/workspace-lifecycle";
import { createTestDb } from "../support/db";
import { FakeMailbox } from "../support/fake-mailbox";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const DAY = 86_400_000;
const T0 = new Date("2026-10-01T15:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);
type Status = Workspace["status"];
const ALL: Status[] = [
  "invited",
  "evaluating",
  "evaluation_expired",
  "setup_paid",
  "active",
  "past_due",
  "canceled",
  "paused",
];

describe("lifecycle rules (pure)", () => {
  const evaluating = { status: "evaluating" as const, evaluationEndsAt: at(3) };

  it("an evaluation counts as expired the moment its clock runs out, cron or not", () => {
    expect(effectiveStatus(evaluating, at(2.9))).toBe("evaluating");
    expect(effectiveStatus(evaluating, at(3))).toBe("evaluation_expired");
    expect(isReadOnly(evaluating, at(3.1))).toBe(true);
  });

  it("only setup_paid and active can send — never during or after evaluation", () => {
    for (const status of ALL) {
      expect(canSend({ status, evaluationEndsAt: null })).toBe(
        status === "setup_paid" || status === "active",
      );
    }
    expect(canSend(evaluating, at(1))).toBe(false);
    expect(canSend(evaluating, at(5))).toBe(false);
  });

  it("jobs run while invited, evaluating, setup_paid, active; everything else is read-only", () => {
    const running = ALL.filter((status) => jobsAllowed({ status, evaluationEndsAt: null }));
    expect(running).toEqual(["invited", "evaluating", "setup_paid", "active"]);
  });

  it("admin moves are only allowed from the right statuses", () => {
    const from = (status: Status) => ({ status, evaluationEndsAt: at(3) });
    expect(canMakeMove("mark_setup_paid", from("evaluating"), T0)).toBe(true);
    expect(canMakeMove("mark_setup_paid", from("active"), T0)).toBe(false);
    expect(canMakeMove("mark_setup_call_done", from("evaluating"), T0)).toBe(false);
    expect(canMakeMove("mark_setup_call_done", from("setup_paid"), T0)).toBe(true);
    expect(canMakeMove("resume", from("active"), T0)).toBe(false);
    expect(canMakeMove("pause", from("canceled"), T0)).toBe(false);
    // An evaluation whose clock ran out can be extended.
    expect(canMakeMove("extend_evaluation", from("evaluating"), at(4))).toBe(true);
  });

  it("resuming goes back as far as the account had got", () => {
    const base = { setupPaidAt: null, setupCallCompletedAt: null, evaluationEndsAt: null };
    expect(resumeTarget(base)).toBe("invited");
    expect(resumeTarget({ ...base, evaluationEndsAt: at(3) }, T0)).toBe("evaluating");
    expect(resumeTarget({ ...base, evaluationEndsAt: at(3) }, at(4))).toBe("evaluation_expired");
    expect(resumeTarget({ ...base, setupPaidAt: T0 })).toBe("setup_paid");
    expect(resumeTarget({ ...base, setupPaidAt: T0, setupCallCompletedAt: T0 })).toBe("active");
  });

  it("shows day N of 3 and time left", () => {
    const w = { status: "evaluating" as const, evaluationStartedAt: T0, evaluationEndsAt: at(3) };
    expect(evaluationClock(w, at(0.1))).toMatchObject({ day: 1, of: 3 });
    expect(evaluationClock(w, at(1.5))).toMatchObject({ day: 2, of: 3 });
    expect(evaluationClock(w, at(2.99))).toMatchObject({ day: 3, of: 3 });
    expect(evaluationClock(w, at(3))).toBeNull();
    expect(timeLeft(2 * DAY + 5 * 3600_000)).toBe("2 days, 5 hours");
    expect(timeLeft(DAY)).toBe("1 day");
    expect(timeLeft(20 * 60_000)).toBe("under an hour");
  });
});

describe("lifecycle in the database", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;

  const workspace = async () =>
    (await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0]!;
  const logged = async (action: string) =>
    (
      await database.select().from(activityLog).where(eq(activityLog.workspaceId, workspaceId))
    ).filter((r) => r.action === action);

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.AI_DAILY_CALL_CAP = "100";
    database = await createTestDb();
    const { workspace: w } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    workspaceId = w.id;
    mailboxId = (
      await saveConnectedMailbox(w, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
  });

  it("connecting Gmail starts a three-day evaluation, once", async () => {
    const w = await workspace();
    expect(w.status).toBe("evaluating");
    expect(w.evaluationEndsAt!.getTime() - w.evaluationStartedAt!.getTime()).toBe(3 * DAY);

    // Reconnecting the same mailbox doesn't restart the clock.
    await saveConnectedMailbox(w, {
      email: "owner@shop.com",
      refreshToken: "rt2",
      grantedScopes: [],
    });
    expect((await workspace()).evaluationEndsAt).toEqual(w.evaluationEndsAt);
    expect(await logged("evaluation_started")).toHaveLength(1);
  });

  it("the backstop starts the clock for invited workspaces that already have Gmail", async () => {
    await database
      .update(workspaces)
      .set({ status: "invited", evaluationStartedAt: null, evaluationEndsAt: null })
      .where(eq(workspaces.id, workspaceId));
    expect(await startPendingEvaluations(T0)).toBe(1);
    expect((await workspace()).evaluationEndsAt).toEqual(at(3));
    expect(await startPendingEvaluations(T0)).toBe(0);
  });

  it("expiry is recorded once, and only when the clock has run out", async () => {
    await database
      .update(workspaces)
      .set({ evaluationStartedAt: T0, evaluationEndsAt: at(3) })
      .where(eq(workspaces.id, workspaceId));
    expect(await expireEvaluations(at(2))).toBe(0);
    expect(await expireEvaluations(at(3))).toBe(1);
    expect(await expireEvaluations(at(4))).toBe(0);
    expect((await workspace()).status).toBe("evaluation_expired");
    expect(await logged("evaluation_expired")).toHaveLength(1);
  });

  it("startEvaluation never moves a workspace that's past invited", async () => {
    await database
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, workspaceId));
    expect(await startEvaluation(workspaceId, T0)).toBe(false);
    expect((await workspace()).status).toBe("active");
  });

  describe("admin moves", () => {
    it("mark setup paid turns sending on; setup call done makes it active", async () => {
      expect(await applyAdminMove(workspaceId, "mark_setup_paid", T0)).toBe("setup_paid");
      const w = await workspace();
      expect(w.setupPaidAt).toEqual(T0);
      expect(canSend(w)).toBe(true);
      expect(await applyAdminMove(workspaceId, "mark_setup_call_done", T0)).toBe("active");
      const [log] = await logged("workspace_status_changed");
      expect(log!.detail).toMatchObject({ by: "admin", move: "mark_setup_paid" });
    });

    it("refuses moves that don't fit the current status", async () => {
      await expect(applyAdminMove(workspaceId, "mark_setup_call_done", T0)).rejects.toBeInstanceOf(
        MoveNotAllowedError,
      );
      await expect(applyAdminMove(workspaceId, "resume", T0)).rejects.toBeInstanceOf(
        MoveNotAllowedError,
      );
      expect((await workspace()).status).toBe("evaluating");
    });

    it("extending an expired evaluation gives three days from now", async () => {
      await database
        .update(workspaces)
        .set({ status: "evaluation_expired", evaluationStartedAt: T0, evaluationEndsAt: at(3) })
        .where(eq(workspaces.id, workspaceId));
      expect(await applyAdminMove(workspaceId, "extend_evaluation", at(5))).toBe("evaluating");
      expect((await workspace()).evaluationEndsAt).toEqual(at(8));
    });

    it("pause then resume returns to where it was", async () => {
      await applyAdminMove(workspaceId, "mark_setup_paid", T0);
      await applyAdminMove(workspaceId, "pause", T0);
      expect((await workspace()).status).toBe("paused");
      expect(await applyAdminMove(workspaceId, "resume", T0)).toBe("setup_paid");
    });
  });

  describe("read-only accounts: nothing is read, drafted, changed in Gmail, or sent", () => {
    let threadId: string;
    let draftId: string;
    let writer: FakeWriter;

    beforeEach(async () => {
      writer = new FakeWriter();
      const [t] = await database
        .insert(threads)
        .values({
          mailboxId,
          gmailThreadId: "g1",
          inInbox: true,
          subject: "SECRET-SUBJECT",
          category: "quote_request",
          classifiedAt: T0,
          lastMessageAt: T0,
        })
        .returning();
      threadId = t!.id;
      await database.insert(messages).values({
        threadId,
        mailboxId,
        gmailMessageId: "g1-m1",
        direction: "in",
        fromAddress: "dana@customer.com",
        fromName: "SECRET-CUSTOMER-NAME",
        bodyText: "SECRET-BODY please quote",
        sentAt: T0,
      });
      const [d] = await database
        .insert(drafts)
        .values({
          threadId,
          mailboxId,
          kind: "reply",
          gmailDraftId: "gd1",
          toAddress: "dana@customer.com",
          subject: "Re: SECRET-SUBJECT",
          body: "SECRET-DRAFT",
          originalBody: "SECRET-DRAFT",
          status: "pending",
          reason: "Quote request.",
          flags: [],
          confidence: 90,
          promptVersion: "draft.v1",
          createdAt: T0,
        })
        .returning();
      draftId = d!.id;
      // Clock ran out but no job has recorded it yet — gates must still hold.
      await database
        .update(workspaces)
        .set({ status: "evaluating", evaluationStartedAt: at(-4), evaluationEndsAt: at(-1) })
        .where(eq(workspaces.id, workspaceId));
    });

    it("no AI calls: classify, draft (auto or owner) and voice all stop", async () => {
      const { transport, calls } = fakeTransport([]);
      setModelTransportForTests(transport);
      await database.update(messages).set({ classifiedAt: null });
      expect((await classifyPending(mailboxId, { now: T0 })).classified).toBe(0);
      await database.update(drafts).set({ status: "discarded" });
      const deps = { writerFor: () => writer, now: () => T0 };
      expect(await createDraftForThread(threadId, { trigger: "auto", ...deps })).toEqual({
        status: "skipped",
        reason: "read_only",
      });
      expect(
        await createDraftForThread(threadId, { trigger: "owner", workspaceId, ...deps }),
      ).toEqual({ status: "skipped", reason: "read_only" });
      const fake = new FakeMailbox();
      expect(await learnVoice(workspaceId, { readerFor: () => fake.reader(), now: () => T0 })).toBe(
        "read_only",
      );
      expect(await workspacesDueForVoiceRefresh(T0)).toEqual([]);
      expect(calls).toHaveLength(0);
      expect(writer.calls).toEqual([]);
      expect(fake.calls).toBe(0);
    });

    it("no Gmail writes: edit and discard are refused, reconcile leaves drafts alone", async () => {
      const deps = { writerFor: () => writer, now: () => T0 };
      await expect(saveDraftEdit(workspaceId, draftId, "new text", deps)).rejects.toBeInstanceOf(
        ReadOnlyError,
      );
      await expect(discardDraft(workspaceId, draftId, deps)).rejects.toBeInstanceOf(ReadOnlyError);
      expect((await reconcileDrafts(mailboxId, deps)).checked).toBe(0);
      expect(writer.calls).toEqual([]);
      const [d] = await database.select().from(drafts).where(eq(drafts.id, draftId));
      expect(d!.status).toBe("pending");
    });

    it("no sending, even though the stored status still says evaluating", async () => {
      await expect(
        sendDraft(workspaceId, draftId, { writerFor: () => writer, now: () => T0 }),
      ).rejects.toBeInstanceOf(SendingBlockedError);
      expect(writer.calls).toEqual([]);
    });

    it("no syncing: the poll skips it and a direct sync is refused before Gmail", async () => {
      expect(await listSyncableMailboxes()).toEqual([]);
      const fake = new FakeMailbox();
      expect(
        await incrementalSync(mailboxId, { readerFor: () => fake.reader(), now: () => T0 }),
      ).toEqual({ status: "skipped", reason: "read_only" });
      expect(fake.calls).toBe(0);
    });

    it("comes back to life when Davi extends it", async () => {
      await applyAdminMove(workspaceId, "extend_evaluation");
      expect((await listSyncableMailboxes()).map((m) => m.id)).toEqual([mailboxId]);
    });
  });

  describe("admin page data", () => {
    it("is only for ADMIN_EMAIL, case-insensitively", () => {
      process.env.ADMIN_EMAIL = "Davi@Example.com";
      expect(isAdminEmail("davi@example.com ")).toBe(true);
      expect(isAdminEmail("owner@shop.com")).toBe(false);
      expect(isAdminEmail(null)).toBe(false);
      delete process.env.ADMIN_EMAIL;
      expect(isAdminEmail("davi@example.com")).toBe(false);
    });

    it("shows health, counts and cost — and no email content or customer names", async () => {
      const [t] = await database
        .insert(threads)
        .values({
          mailboxId,
          gmailThreadId: "g9",
          subject: "SECRET-SUBJECT",
          summary: "SECRET-SUMMARY",
        })
        .returning();
      await database.insert(drafts).values({
        threadId: t!.id,
        mailboxId,
        kind: "reply",
        gmailDraftId: "gd9",
        toAddress: "secret-customer@x.com",
        subject: "SECRET-SUBJECT",
        body: "SECRET-DRAFT",
        originalBody: "SECRET-DRAFT",
        status: "pending",
        reason: "SECRET-REASON",
        flags: [],
        confidence: 90,
        promptVersion: "draft.v1",
        createdAt: T0,
      });
      await database
        .insert(usage)
        .values({ workspaceId, period: "2026-10-01", aiCalls: 7, estimatedCostCentiCents: 12_345 });

      const [row] = await adminOverview(at(0.1));
      expect(row).toMatchObject({
        ownerEmail: "owner@shop.com",
        status: "evaluating",
        mailboxes: { total: 1, needReconnect: 0 },
        drafts: { pending: 1, createdThisMonth: 1 },
        ai: { callsToday: 7, callsThisMonth: 7, costCentsThisMonth: 123 },
      });
      expect(JSON.stringify(row)).not.toMatch(/SECRET|secret-customer/);
    });
  });
});
