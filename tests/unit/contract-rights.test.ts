/**
 * Check 38 P5 (wave 2, Prompt versions step 1): a homeowner asking about cancelling a signed
 * contract or getting the deposit back comes to the owner with its own reason, gets no automatic
 * draft (the owner's tap still drafts), and autopilot refuses it.
 */
import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import { CONTRACT_RIGHTS_REASON } from "@/ai/guards";
import type { Database } from "@/db";
import { messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { guardrailCodes, guardrailReasons } from "@/server/autopilot";
import { classifyPending } from "@/server/classification";
import { createDraftForThread } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-10-10T14:00:00Z");
const E11 =
  "We signed Saturday at our kitchen table and gave you the deposit. We've had second thoughts about the kitchen. Can we still cancel, and would we get the deposit back?";

let database: Database;
let workspaceId: string;
let mailboxId: string;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
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
}, 30_000);

async function inbound(body: string) {
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: `g-${randomBytes(4).toString("hex")}`,
      inInbox: true,
      subject: "Second thoughts",
      lastMessageAt: NOW,
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `m-${randomBytes(4).toString("hex")}`,
    direction: "in",
    fromAddress: "erin@customer.com",
    fromName: "Erin Walsh",
    subject: "Second thoughts",
    bodyText: body,
    labelIds: ["INBOX"],
    sentAt: new Date(NOW.getTime() - 3_600_000),
  });
  return t!.id;
}

const modelDraft = {
  body: "Hi Erin,\n\nYou have three days to cancel and we'll return the deposit in full.\n\nThanks,\nDavi",
  reason: "Answered the cancel question.",
  flags: [],
  confidence: 0.9,
  used_facts: [],
  opening: "not_first",
};

describe("Check 38 P5: contract rights", () => {
  it("E11 comes to the owner with the reason and the mark, whatever the model said", async () => {
    const t = await inbound(E11);
    // A model that reads it as an ordinary customer question, confident, no signals.
    setModelTransportForTests(
      fakeTransport([classification({ category: "customer_question", confidence: 0.9 })]).transport,
    );
    await classifyPending(mailboxId, { now: NOW });
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row).toMatchObject({ needsOwner: true, needsOwnerReason: CONTRACT_RIGHTS_REASON });
    expect(row!.extracted).toMatchObject({ contract_rights: true, owner_code: "contract_rights" });
    // It never sets the complaint mark by itself.
    expect(row!.complainedAt).toBeNull();
    expect((row!.extracted as { disputed?: unknown }).disputed).toBeUndefined();
  });

  it("no job drafts it (no model call, no Gmail draft); the owner's tap does", async () => {
    const t = await inbound(E11);
    setModelTransportForTests(
      fakeTransport([classification({ category: "customer_question", confidence: 0.9 })]).transport,
    );
    await classifyPending(mailboxId, { now: NOW });
    // The thread needs the owner, so a job stops there; with the needs-you flag cleared by
    // hand the contract-rights mark alone still stops every job trigger.
    await database.update(threads).set({ needsOwner: false }).where(eq(threads.id, t));
    const writer = new FakeWriter();
    const { transport, calls } = fakeTransport([modelDraft]);
    setModelTransportForTests(transport);
    for (const trigger of ["auto", "followup"] as const) {
      expect(
        await createDraftForThread(t, { trigger, writerFor: () => writer, now: () => NOW }),
      ).toMatchObject({ status: "skipped", reason: "contract_rights" });
    }
    expect(calls).toHaveLength(0);
    expect(writer.drafts.size).toBe(0);
    const tapped = await createDraftForThread(t, {
      trigger: "owner",
      workspaceId,
      writerFor: () => writer,
      now: () => NOW,
    });
    expect(tapped.status).toBe("created");
  });

  it("'can we cancel Tuesday' is an ordinary email: drafted by a job", async () => {
    const t = await inbound(
      "Can we cancel Tuesday's visit? Something came up. Any day next week works.",
    );
    setModelTransportForTests(
      fakeTransport([classification({ category: "scheduling", confidence: 0.9 })]).transport,
    );
    await classifyPending(mailboxId, { now: NOW });
    const [row] = await database.select().from(threads).where(eq(threads.id, t));
    expect(row!.needsOwner).toBe(false);
    expect((row!.extracted as { contract_rights?: unknown }).contract_rights).toBeUndefined();
    const writer = new FakeWriter();
    setModelTransportForTests(
      fakeTransport([
        { ...modelDraft, body: "Hi Erin,\n\nNo problem, what day works?\n\nThanks,\nDavi" },
      ]).transport,
    );
    expect(
      (await createDraftForThread(t, { trigger: "auto", writerFor: () => writer, now: () => NOW }))
        .status,
    ).toBe("created");
  });

  it("GUARDRAIL: autopilot refuses the mark and the words", () => {
    const OK = {
      category: "customer_question",
      needsOwner: false,
      kind: "reply" as const,
      confidencePct: 95,
      flags: [],
      amountsInEmail: [],
      draftBody: "Thursday works.",
      knownCustomer: true,
      purpose: null,
    };
    expect(guardrailCodes(OK)).not.toContain("contract_rights");
    expect(guardrailCodes({ ...OK, contractRights: true })).toContain("contract_rights");
    expect(guardrailReasons({ ...OK, contractRights: true }).join()).toMatch(
      /rights under the contract/,
    );
  });
});
