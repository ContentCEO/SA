import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v2";
import type { Database } from "@/db";
import {
  activityLog,
  drafts,
  messages,
  rules,
  threads,
  workspaces,
  type Workspace,
} from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  accountLockReason,
  AutopilotNotAllowedError,
  considerAutopilot,
  DAILY_AUTOPILOT_CAP,
  EARN_THRESHOLD,
  GRACE_MINUTES,
  guardrailReasons,
  holdAutopilot,
  overdueAutopilotDrafts,
  runAutopilotSend,
  setAutopilot,
  type GuardrailInput,
} from "@/server/autopilot";
import { createDraftForThread, saveDraftEdit } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { setWorkspacePlan } from "@/server/workspace-lifecycle";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-10-10T14:00:00Z");
const later = (min: number) => new Date(NOW.getTime() + min * 60_000);
const cleanDraft = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  body: "Hi Dana,\n\nThursday morning works on our end — see you then.\n\nThanks, Davi",
  reason: "Scheduling. Confirmed the visit.",
  flags: [],
  confidence: 0.95,
  ...over,
});

describe("account lock (layer 1)", () => {
  const w = (plan: Workspace["plan"], status: Workspace["status"]) => ({
    plan,
    status,
    evaluationEndsAt: null,
  });
  it("needs Crew or Company AND a finished setup", () => {
    expect(accountLockReason(w(null, "active"))).toMatch(/Crew and Company/);
    expect(accountLockReason(w("solo", "active"))).toMatch(/Crew and Company/);
    expect(accountLockReason(w("crew", "evaluating"))).toMatch(/setup call/);
    expect(accountLockReason(w("crew", "setup_paid"))).toMatch(/setup call/);
    expect(accountLockReason(w("crew", "paused"))).toMatch(/setup call/);
    expect(accountLockReason(w("crew", "active"))).toBeNull();
    expect(accountLockReason(w("company", "active"))).toBeNull();
  });
});

describe("per-email guardrails (layer 3)", () => {
  const ok: GuardrailInput = {
    category: "scheduling",
    needsOwner: false,
    kind: "reply",
    confidencePct: 92,
    flags: [],
    amountsInEmail: [],
    draftBody: "Thursday works.",
    knownCustomer: true,
  };
  it("a clean reply to a known customer may go", () => {
    expect(guardrailReasons(ok)).toEqual([]);
  });
  it.each([
    ["complaints", { category: "complaint" }],
    ["noise", { category: "noise" }],
    ["anything flagged for the owner", { needsOwner: true }],
    ["follow-ups", { kind: "followup" as const }],
    ["low confidence", { confidencePct: 84 }],
    ["missing confidence", { confidencePct: null }],
    ["drafts with things to check", { flags: ["Check you can do Thursday."] }],
    ["invoices with an amount", { category: "invoice_payment", amountsInEmail: [450] }],
    ["any draft that mentions money", { draftBody: "That's $95 for the call-out." }],
    ["people the owner has never written to", { knownCustomer: false }],
  ])("never: %s", (_label, change) => {
    expect(guardrailReasons({ ...ok, ...change }).length).toBeGreaterThan(0);
  });
  it("an invoice question with no amount is allowed", () => {
    expect(guardrailReasons({ ...ok, category: "invoice_payment" })).toEqual([]);
  });
});

describe("in the database", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
  let writer: FakeWriter;
  let g = 0;
  const deps = (at = NOW) => ({ writerFor: () => writer, now: () => at });
  const ws = async () =>
    (await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0]!;

  /** A conversation with Dana; by default the owner has written to her before. */
  async function conversation(
    opts: { category?: string; known?: boolean; from?: string; needsOwner?: boolean } = {},
  ) {
    const id = `g${++g}`;
    const from = opts.from ?? "dana@customer.com";
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: id,
        inInbox: true,
        subject: "Visit",
        category: opts.category ?? "scheduling",
        needsOwner: opts.needsOwner ?? false,
        classifiedAt: NOW,
        lastMessageAt: new Date(NOW.getTime() - 3600_000),
      })
      .returning();
    if (opts.known ?? true) {
      await database.insert(messages).values({
        threadId: t!.id,
        mailboxId,
        gmailMessageId: `${id}-earlier`,
        direction: "out",
        fromAddress: "owner@shop.com",
        toAddresses: [from],
        bodyText: "Earlier job, thanks.",
        sentAt: new Date(NOW.getTime() - 30 * 86_400_000),
      });
    }
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-in`,
      rfc822MessageId: `<${id}@customer.com>`,
      direction: "in",
      fromAddress: from,
      fromName: "Dana Ruiz",
      subject: "Visit",
      bodyText: "Can you come Thursday morning?",
      sentAt: new Date(NOW.getTime() - 3600_000),
    });
    return t!.id;
  }

  async function drafted(threadId: string, model: ModelDraft = cleanDraft()) {
    setModelTransportForTests(fakeTransport([model]).transport);
    const r = await createDraftForThread(threadId, { trigger: "auto", ...deps() });
    if (r.status !== "created") throw new Error(`no draft: ${JSON.stringify(r)}`);
    return r.draftId;
  }

  /** Evidence: n replies in a category sent exactly as drafted. */
  async function earn(category: string, n: number, status: "sent" | "edited_and_sent" = "sent") {
    for (let i = 0; i < n; i++) {
      const t = await conversation({ category });
      await database.insert(drafts).values({
        threadId: t,
        mailboxId,
        gmailDraftId: `earned-${t}`,
        sentGmailMessageId: `sent-${t}`,
        toAddress: "dana@customer.com",
        subject: "Re",
        body: "b",
        originalBody: "b",
        status,
        reason: "r",
        promptVersion: "draft.v1",
        createdAt: new Date(NOW.getTime() - 86_400_000),
        decidedAt: new Date(NOW.getTime() - 86_400_000),
      });
    }
  }

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.AI_DAILY_CALL_CAP = "500";
    database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    workspaceId = workspace.id;
    mailboxId = (
      await saveConnectedMailbox(workspace, {
        email: "owner@shop.com",
        refreshToken: "rt",
        grantedScopes: [],
      })
    ).id;
    await database
      .update(workspaces)
      .set({ status: "active", plan: "crew" })
      .where(eq(workspaces.id, workspaceId));
    writer = new FakeWriter();
  });

  describe("turning it on (layer 2)", () => {
    it(`needs ${EARN_THRESHOLD} replies in that category sent without edits`, async () => {
      await earn("scheduling", EARN_THRESHOLD - 1);
      await earn("scheduling", 5, "edited_and_sent"); // edited ones don't count
      await expect(setAutopilot(await ws(), "scheduling", true, NOW)).rejects.toBeInstanceOf(
        AutopilotNotAllowedError,
      );
      await earn("scheduling", 1);
      await setAutopilot(await ws(), "scheduling", true, NOW);
      const [r] = await database.select().from(rules);
      expect(r).toMatchObject({ category: "scheduling", mode: "autopilot" });
    });

    it("is refused on the wrong plan or before setup is done, and never for complaints", async () => {
      await earn("scheduling", EARN_THRESHOLD);
      await earn("complaint", EARN_THRESHOLD);
      await database.update(workspaces).set({ plan: "solo" });
      await expect(setAutopilot(await ws(), "scheduling", true, NOW)).rejects.toThrow(/Crew/);
      await database.update(workspaces).set({ plan: "crew", status: "setup_paid" });
      await expect(setAutopilot(await ws(), "scheduling", true, NOW)).rejects.toThrow(/setup/);
      await database.update(workspaces).set({ status: "active" });
      await expect(setAutopilot(await ws(), "complaint", true, NOW)).rejects.toBeInstanceOf(
        AutopilotNotAllowedError,
      );
    });
  });

  describe("the grace window and the send", () => {
    beforeEach(async () => {
      await earn("scheduling", EARN_THRESHOLD);
      await setAutopilot(await ws(), "scheduling", true, NOW);
    });

    it(`waits ${GRACE_MINUTES} minutes, checks again, then sends as autopilot`, async () => {
      const draftId = await drafted(await conversation());
      const at = await considerAutopilot(draftId, NOW);
      expect(at).toEqual(later(GRACE_MINUTES));

      expect(await runAutopilotSend(draftId, deps(later(5)))).toEqual({ status: "not_due" });
      expect(writer.sent).toHaveLength(0);

      expect(await runAutopilotSend(draftId, deps(later(GRACE_MINUTES)))).toEqual({
        status: "sent",
      });
      expect(writer.sent).toHaveLength(1);
      const [d] = await database.select().from(drafts).where(eq(drafts.id, draftId));
      expect(d!.status).toBe("sent");
      const [log] = await database
        .select()
        .from(activityLog)
        .where(eq(activityLog.action, "reply_sent"));
      expect(log).toMatchObject({ actor: "squared_away", detail: { autopilot: true } });

      // Running again (a retried job) does nothing.
      expect(await runAutopilotSend(draftId, deps(later(20)))).toEqual({ status: "gone" });
      expect(writer.sent).toHaveLength(1);
    });

    it("Hold it: never sends, and it waits for the owner's tap", async () => {
      const draftId = await drafted(await conversation());
      await considerAutopilot(draftId, NOW);
      expect(await holdAutopilot(workspaceId, draftId)).toBe(true);
      expect(await runAutopilotSend(draftId, deps(later(30)))).toMatchObject({
        status: "stood_down",
      });
      expect(writer.sent).toHaveLength(0);
      const [d] = await database.select().from(drafts).where(eq(drafts.id, draftId));
      expect(d).toMatchObject({ status: "pending", autoSendAt: null });
    });

    it("someone else can't hold (or see) another owner's draft", async () => {
      const draftId = await drafted(await conversation());
      await considerAutopilot(draftId, NOW);
      const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
      expect(await holdAutopilot(other.id, draftId)).toBe(false);
    });

    it("an owner edit stands autopilot down", async () => {
      const draftId = await drafted(await conversation());
      await considerAutopilot(draftId, NOW);
      await saveDraftEdit(workspaceId, draftId, "Hi Dana, Thursday at 8 works.", deps());
      expect(await runAutopilotSend(draftId, deps(later(30)))).toMatchObject({
        status: "stood_down",
      });
      expect(writer.sent).toHaveLength(0);
    });

    it("new mail in the conversation stands it down", async () => {
      const t = await conversation();
      const draftId = await drafted(t);
      await considerAutopilot(draftId, NOW);
      await database.insert(messages).values({
        threadId: t,
        mailboxId,
        gmailMessageId: "customer-again",
        direction: "in",
        fromAddress: "dana@customer.com",
        bodyText: "Actually, can we do Friday?",
        sentAt: later(3),
      });
      expect(await runAutopilotSend(draftId, deps(later(30)))).toMatchObject({
        status: "stood_down",
      });
      expect(writer.sent).toHaveLength(0);
    });

    it("switching autopilot off, a plan change, or a paused account all stop a countdown", async () => {
      const a = await drafted(await conversation());
      await considerAutopilot(a, NOW);
      await setAutopilot(await ws(), "scheduling", false, NOW);
      expect(
        (await database.select().from(drafts).where(eq(drafts.id, a)))[0]!.autoSendAt,
      ).toBeNull();

      await setAutopilot(await ws(), "scheduling", true, NOW);
      const b = await drafted(await conversation());
      await considerAutopilot(b, NOW);
      await setWorkspacePlan(workspaceId, "solo", NOW);
      expect(await runAutopilotSend(b, deps(later(30)))).toMatchObject({ status: "stood_down" });
      expect((await database.select().from(rules))[0]!.mode).toBe("draft");

      await setWorkspacePlan(workspaceId, "crew", NOW);
      await setAutopilot(await ws(), "scheduling", true, NOW);
      const c = await drafted(await conversation());
      await considerAutopilot(c, NOW);
      await database.update(workspaces).set({ status: "paused" });
      expect(await runAutopilotSend(c, deps(later(30)))).toMatchObject({ status: "stood_down" });
      expect(writer.sent).toHaveLength(0);
    });

    it("doesn't start for strangers, money, flags, low confidence, complaints or other categories", async () => {
      const cases = [
        await drafted(await conversation({ known: false, from: "new@person.com" })),
        await drafted(
          await conversation(),
          cleanDraft({ body: "Hi Dana, it's $95 for the visit." }),
        ),
        await drafted(await conversation(), cleanDraft({ flags: ["Check Thursday works."] })),
        await drafted(await conversation(), cleanDraft({ confidence: 0.7 })),
        await drafted(await conversation({ category: "customer_question" })), // autopilot not on
      ];
      for (const d of cases) expect(await considerAutopilot(d, NOW)).toBeNull();
      // Complaints aren't even auto-drafted; drafted by the owner, they still can't go.
      const t = await conversation({ category: "complaint", needsOwner: true });
      setModelTransportForTests(fakeTransport([cleanDraft()]).transport);
      const r = await createDraftForThread(t, { trigger: "owner", workspaceId, ...deps() });
      if (r.status !== "created") throw new Error("expected a draft");
      expect(await considerAutopilot(r.draftId, NOW)).toBeNull();
      expect(await overdueAutopilotDrafts(later(60))).toEqual([]);
    });

    it(`stops after ${DAILY_AUTOPILOT_CAP} a day`, async () => {
      for (let i = 0; i < DAILY_AUTOPILOT_CAP; i++) {
        await database.insert(activityLog).values({
          workspaceId,
          actor: "squared_away",
          action: "autopilot_scheduled",
          createdAt: later(-60),
        });
      }
      const draftId = await drafted(await conversation());
      expect(await considerAutopilot(draftId, NOW)).toBeNull();
    });

    it("lost send events are picked up by the backstop", async () => {
      const draftId = await drafted(await conversation());
      await considerAutopilot(draftId, NOW);
      expect(await overdueAutopilotDrafts(later(GRACE_MINUTES + 1))).toEqual([]);
      expect(await overdueAutopilotDrafts(later(GRACE_MINUTES + 6))).toEqual([draftId]);
    });
  });
});
