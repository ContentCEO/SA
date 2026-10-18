import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { ModelDraft } from "@/ai/prompts/draft.v5";
import type { Database } from "@/db";
import { activityLog, businessProfiles, messages, threads, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { guardrailReasons } from "@/server/autopilot";
import { classifyPending } from "@/server/classification";
import { createDraftForThread } from "@/server/drafts";
import { listCustomers } from "@/server/customers";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { businessProfileInput, saveBusinessProfile } from "@/server/profile";
import { isCrewAddress } from "@/server/sender-rules";
import { crewSql } from "@/server/thread-sql";
import { createTestDb } from "../support/db";
import { classification, fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

/**
 * Check 22 P10 + 41 P6: the owner's own people (the crew list, another connected Gmail address,
 * their business domain) are never customers, never sorted by the model without a reason, and
 * never drafted by a job. The owner's own tap still drafts.
 */

const NOW = new Date("2026-09-28T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const modelDraft = (over: Partial<ModelDraft> = {}): ModelDraft => ({
  body: "Hey Jay,\n\nThanks for the heads up.\n\nDavi",
  reason: "Crew note.",
  flags: [],
  confidence: 0.9,
  used_facts: [],
  ...over,
});

let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
let g = 0;
const deps = () => ({ writerFor: () => writer, now: () => NOW });

const profileForm = (over: Record<string, string> = {}) => ({
  businessName: "Rosa Painting",
  trade: "painting",
  services: "Interior and exterior painting",
  serviceArea: "",
  hours: "",
  leadTime: "",
  pricingNotes: "",
  paymentTerms: "",
  policies: "",
  signature: "",
  doNotPromise: "",
  vipSenders: "",
  amountThresholdDollars: "2500",
  ...over,
});

async function setCrew(list: string[]) {
  await database
    .insert(businessProfiles)
    .values({ workspaceId, crewAddresses: list })
    .onConflictDoUpdate({ target: businessProfiles.workspaceId, set: { crewAddresses: list } });
}

async function inbound(
  from: string,
  body: string,
  over: { category?: string | null; extracted?: Record<string, unknown>; name?: string } = {},
) {
  const id = `c${++g}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Monday",
      category: over.category ?? null,
      extracted: over.extracted ?? null,
      classifiedAt: over.category ? NOW : null,
      lastMessageAt: hoursAgo(1),
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `${id}-in`,
    rfc822MessageId: `<${id}@mail.x.com>`,
    direction: "in",
    fromAddress: from,
    fromName: over.name ?? "Jay",
    replyToHeader: {},
    subject: "Monday",
    bodyText: body,
    labelIds: ["INBOX"],
    sentAt: hoursAgo(2),
  });
  return t!.id;
}
const threadRow = async (id: string) =>
  (await database.select().from(threads).where(eq(threads.id, id)))[0]!;

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
  writer = new FakeWriter();
});

describe("who is crew (pure + SQL twin)", () => {
  const ctx = { listed: ["jay.paints@gmail.com"], mailboxEmails: ["owner@shop.com"] };
  const table: [string, boolean][] = [
    ["jay.paints@gmail.com", true],
    ["JAY.PAINTS@gmail.com ", true],
    ["owner@shop.com", true],
    // The business domain counts only for filing a row on Customers (includeDomain).
    ["mike@shop.com", false],
    ["dana@gmail.com", false],
    ["dana@shop.co", false],
    ["mike@notshop.com", false],
    ["not-an-address", false],
  ];
  it("listed, own Gmail address, or own business domain", () => {
    for (const [a, want] of table) expect(isCrewAddress(a, ctx), a).toBe(want);
    expect(isCrewAddress("mike@shop.com", ctx, { includeDomain: true })).toBe(true);
    expect(isCrewAddress("dana@shop.co", ctx, { includeDomain: true })).toBe(false);
    // Public webmail is never a business domain.
    expect(
      isCrewAddress("anyone@gmail.com", { listed: [], mailboxEmails: ["rosa@gmail.com"] }),
    ).toBe(false);
    expect(isCrewAddress("rosa@gmail.com", { listed: [], mailboxEmails: ["rosa@gmail.com"] })).toBe(
      true,
    );
  });
  it("the SQL twin agrees", async () => {
    await setCrew(ctx.listed);
    for (const [a, want] of table) {
      const res = (await database.execute(
        sql`select ${crewSql(workspaceId, sql`${a}`)} as v`,
      )) as unknown as { rows: { v: boolean }[] };
      expect(Boolean(res.rows[0]!.v), a).toBe(want);
    }
    for (const a of ["mike@shop.com", "dana@gmail.com", "jay.paints@gmail.com"]) {
      const res = (await database.execute(
        sql`select ${crewSql(workspaceId, sql`${a}`, { includeDomain: true })} as v`,
      )) as unknown as { rows: { v: boolean }[] };
      expect(Boolean(res.rows[0]!.v), a).toBe(isCrewAddress(a, ctx, { includeDomain: true }));
    }
  });
});

describe("Settings: the crew list", () => {
  it("validates like the VIP list: emails only, lowercased, duplicates removed", () => {
    const ok = businessProfileInput.parse(
      profileForm({ crewAddresses: "Jay@Gmail.com\n\njay@gmail.com\n  sam@x.com " }),
    );
    expect(ok.crewAddresses).toEqual(["jay@gmail.com", "sam@x.com"]);
    const bad = businessProfileInput.safeParse(profileForm({ crewAddresses: "jay at gmail" }));
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error)).toContain("Each line should be one email address.");
    const many = Array.from({ length: 31 }, (_, i) => `c${i}@x.com`).join("\n");
    expect(businessProfileInput.safeParse(profileForm({ crewAddresses: many })).success).toBe(
      false,
    );
    // A form without the field leaves the saved list alone.
    expect(businessProfileInput.parse(profileForm()).crewAddresses).toBeUndefined();
  });

  it("saves, and logs a changed list with its size only", async () => {
    await saveBusinessProfile(
      workspaceId,
      businessProfileInput.parse(profileForm({ crewAddresses: "jay@gmail.com\nsam@x.com" })),
    );
    // Saving the same list again (or without the field) logs nothing new.
    await saveBusinessProfile(
      workspaceId,
      businessProfileInput.parse(profileForm({ crewAddresses: "sam@x.com\njay@gmail.com" })),
    );
    await saveBusinessProfile(workspaceId, businessProfileInput.parse(profileForm()));
    const [p] = await database.select().from(businessProfiles);
    expect(p!.crewAddresses).toEqual(["sam@x.com", "jay@gmail.com"]);
    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "crew_list_saved"));
    expect(logs.map((l) => l.detail)).toEqual([{ count: 2 }]);
    expect(JSON.stringify(await database.select().from(activityLog))).not.toContain("jay@");
  });
});

describe("sorting and drafting crew mail", () => {
  it("someone on the owner's own domain is still sorted and drafted like anyone (not on the list)", async () => {
    const t = await inbound("dana@shop.com", "Can you quote a kitchen?", { name: "Dana" });
    const { transport, calls } = fakeTransport([classification({ category: "quote_request" })]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(calls).toHaveLength(1);
    expect((await threadRow(t)).extracted).not.toHaveProperty("crew");
  });

  it("a listed gmail.com crew member: no model call, no job draft, not a customer", async () => {
    await setCrew(["jay.paints@gmail.com"]);
    const t = await inbound(
      "jay.paints@gmail.com",
      "hey rosa cant make it monday, car is in the shop",
    );
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    expect(await classifyPending(mailboxId, { now: NOW })).toMatchObject({ classified: 1 });
    expect(calls).toHaveLength(0);
    const row = await threadRow(t);
    expect(row).toMatchObject({ category: "scheduling", needsOwner: false });
    expect((row.extracted as { crew?: boolean }).crew).toBe(true);

    expect(await createDraftForThread(t, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "crew",
    });
    expect(await createDraftForThread(t, { trigger: "followup", ...deps() })).toEqual({
      status: "skipped",
      reason: "crew",
    });
    expect(writer.calls).toHaveLength(0);
    expect((await listCustomers(workspaceId, NOW)).map((c) => c.kind)).toEqual(["crew"]);
  });

  it("the owner's own tap still drafts a reply to the crew", async () => {
    await setCrew(["jay.paints@gmail.com"]);
    const t = await inbound("jay.paints@gmail.com", "Need 2 boxes of 3in screws for tomorrow.");
    setModelTransportForTests(fakeTransport([]).transport);
    await classifyPending(mailboxId, { now: NOW });
    setModelTransportForTests(fakeTransport([modelDraft()]).transport);
    expect(
      await createDraftForThread(t, { trigger: "owner", workspaceId, ...deps() }),
    ).toMatchObject({ status: "created" });
  });

  it("email from another of the owner's own Gmail addresses is treated the same", async () => {
    await database.update(workspaces).set({ plan: "crew" }).where(eq(workspaces.id, workspaceId));
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    await saveConnectedMailbox(workspace, {
      email: "rosa.personal@gmail.com",
      refreshToken: "rt2",
      grantedScopes: [],
    });
    const t = await inbound("rosa.personal@gmail.com", "Photos from the Smith job", {
      name: "Rosa",
    });
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(calls).toHaveLength(0);
    expect((await threadRow(t)).extracted).toMatchObject({ crew: true });
    expect(await createDraftForThread(t, { trigger: "auto", ...deps() })).toMatchObject({
      reason: "crew",
    });
  });

  it("a crew email about a gas smell still goes to the owner, top priority", async () => {
    await setCrew(["jay.paints@gmail.com"]);
    const t = await inbound("jay.paints@gmail.com", "I smell gas at the Smith job, what do I do");
    const { transport, calls } = fakeTransport([classification({ category: "scheduling" })]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(calls).toHaveLength(1);
    const row = await threadRow(t);
    expect(row.needsOwner).toBe(true);
    expect(row.extracted).toMatchObject({ gas_smell: true, crew: true });
    // No automatic safety note to the crew either: the owner calls.
    expect(await createDraftForThread(t, { trigger: "auto", ...deps() })).toMatchObject({
      reason: "crew",
    });
  });

  it("a customer's conversation the crew replied on is still the customer's", async () => {
    await setCrew(["jay.paints@gmail.com"]);
    const t = await inbound("dana@x.com", "Can you paint our deck?", { name: "Dana" });
    await database.insert(messages).values({
      threadId: t,
      mailboxId,
      gmailMessageId: "crew-reply",
      direction: "in",
      fromAddress: "jay.paints@gmail.com",
      fromName: "Jay",
      replyToHeader: {},
      subject: "Re: Monday",
      bodyText: "I can look at it Tuesday",
      labelIds: ["INBOX"],
      sentAt: hoursAgo(1),
    });
    const { transport, calls } = fakeTransport([classification({ category: "quote_request" })]);
    setModelTransportForTests(transport);
    await classifyPending(mailboxId, { now: NOW });
    expect(calls).toHaveLength(1);
    expect((await threadRow(t)).extracted).not.toHaveProperty("crew");
    const kinds = Object.fromEntries(
      (await listCustomers(workspaceId, NOW)).map((c) => [c.address, c.kind]),
    );
    expect(kinds).toEqual({ "dana@x.com": "customer", "jay.paints@gmail.com": "crew" });
  });

  it("a name added to the list later stops job drafts on older threads", async () => {
    const t = await inbound("jay.paints@gmail.com", "Running late", { category: "scheduling" });
    await setCrew(["jay.paints@gmail.com"]);
    setModelTransportForTests(fakeTransport([modelDraft()]).transport);
    expect(await createDraftForThread(t, { trigger: "auto", ...deps() })).toEqual({
      status: "skipped",
      reason: "crew",
    });
  });
});

describe("autopilot", () => {
  it("never sends to the crew", () => {
    const ok = {
      category: "scheduling",
      needsOwner: false,
      kind: "reply" as const,
      confidencePct: 92,
      flags: [],
      amountsInEmail: [],
      draftBody: "Thursday works.",
      knownCustomer: true,
      purpose: null,
    };
    expect(guardrailReasons(ok)).toEqual([]);
    expect(guardrailReasons({ ...ok, crew: true })).toEqual([
      "Emails to your crew always wait for you.",
    ]);
  });
});
