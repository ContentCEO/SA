import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import { messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { isCustomerRobot } from "@/server/customer-robot-rules";
import { customerByKey, listCustomers } from "@/server/customers";
import { createDraftForThread } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { customerRobotSql } from "@/server/thread-sql";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

/**
 * Check 13 P2 + 41 P7: form robots, lead portals, receipt senders and job boards are never
 * customers, and their keys don't open a customer page.
 */

const NOW = new Date("2026-10-10T14:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);
let database: Database;
let workspaceId: string;
let mailboxId: string;
let g = 0;

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
});

async function convo(
  from: string,
  o: {
    name?: string;
    category?: string;
    replyTo?: { address: string; name?: string } | Record<string, never> | null;
  } = {},
) {
  const id = `r${++g}`;
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Job",
      category: o.category ?? "quote_request",
      summary: "Someone wants something.",
      classifiedAt: NOW,
      lastMessageAt: daysAgo(1),
    })
    .returning();
  const [m] = await database
    .insert(messages)
    .values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-in`,
      rfc822MessageId: `<${id}@x.com>`,
      direction: "in",
      fromAddress: from,
      fromName: o.name ?? "Sender",
      replyToHeader: o.replyTo === undefined ? {} : o.replyTo,
      subject: "Job",
      bodyText: "Hello",
      sentAt: daysAgo(1),
    })
    .returning();
  return { threadId: t!.id, messageId: m!.id };
}

const robots: [string, boolean][] = [
  ["website@acme-site.com", true],
  ["webmaster@acme-site.com", true],
  ["forms@acme-site.com", true],
  ["form-submission@squarespace.info", true],
  ["leads@angi.com", true],
  ["pro@homeadvisor.com", true],
  ["quickbooks@notification.intuit.com", true],
  ["receipts@stripe.com", true],
  ["noreply@thumbtack.com", true],
  ["indeedapply@indeed.com", true],
  ["alerts@ziprecruiter.com", true],
  // A platform's per-customer relay is that person.
  ["reply+8x2k@messages.thumbtack.com", false],
  ["dana@gmail.com", false],
  ["dana@indeedhomes.com", false],
  ["webdesigner@acme.com", false],
  ["not-an-address", false],
];

describe("who is a robot (pure + SQL twin)", () => {
  it("the JavaScript rule", () => {
    for (const [a, want] of robots) expect(isCustomerRobot(a), a).toBe(want);
  });
  it("the SQL twin agrees on every case", async () => {
    for (const [a] of robots) {
      const res = (await database.execute(
        sql`select ${customerRobotSql(sql`${a}`)} as v`,
      )) as unknown as { rows: { v: boolean }[] };
      expect([a, Boolean(res.rows[0]!.v)]).toEqual([a, isCustomerRobot(a)]);
    }
  });
});

describe("Customers leaves robots out", () => {
  it("form robots, lead portals, receipts and job boards are not listed; their keys 404", async () => {
    const dana = await convo("dana@gmail.com", { name: "Dana Ruiz" });
    const robotKeys: string[] = [];
    for (const [a, robot] of robots)
      if (robot) robotKeys.push((await convo(a, { category: "customer_question" })).messageId);
    // A Squarespace lead with a usable Reply-To is the person.
    await convo("form-submission@squarespace.info", {
      name: "Squarespace",
      replyTo: { address: "sam@yahoo.com", name: "Sam Lee" },
    });
    const junk = await convo("ads@deals.com", { category: "noise" });

    const list = await listCustomers(workspaceId, NOW);
    expect(list.map((c) => c.address).sort()).toEqual(["dana@gmail.com", "sam@yahoo.com"]);
    expect(list.find((c) => c.address === "sam@yahoo.com")!.name).toBe("Sam Lee");
    expect((await customerByKey(workspaceId, dana.messageId))!.address).toBe("dana@gmail.com");
    for (const key of robotKeys) expect(await customerByKey(workspaceId, key)).toBeNull();
    expect(await customerByKey(workspaceId, junk.messageId)).toBeNull();
  });

  it("a job-board notice never gets an automatic draft (Check 41 P7)", async () => {
    const indeed = await convo("indeedapply@indeed.com", {
      name: "Indeed",
      category: "customer_question",
    });
    const { transport, calls } = fakeTransport([]);
    setModelTransportForTests(transport);
    const writer = new FakeWriter();
    expect(
      await createDraftForThread(indeed.threadId, {
        trigger: "auto",
        writerFor: () => writer,
        now: () => NOW,
      }),
    ).toEqual({ status: "skipped", reason: "no_reply_address" });
    expect(calls).toHaveLength(0);
    expect(writer.calls).toHaveLength(0);
  });
});
