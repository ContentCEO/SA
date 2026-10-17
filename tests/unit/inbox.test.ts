import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { listInboxThreads } from "@/server/inbox";
import { compareInbox } from "@/server/inbox-rules";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";

/** Inbox screen queries with the database (wave 2, Check 10). */

const NOW = new Date("2026-10-15T20:00:00Z");
const HOUR = 3_600_000;
const ago = (h: number) => new Date(NOW.getTime() - h * HOUR);
let database: Database;
let workspaceId: string;
let mailboxId: string;
let n = 0;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
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

async function seedThread(o: {
  category?: string | null;
  priority?: string;
  urgency?: string;
  needsOwner?: boolean;
  inAt?: Date | null;
  outAt?: Date;
  box?: string;
  extracted?: Record<string, unknown>;
}) {
  const id = `g${++n}`;
  const box = o.box ?? mailboxId;
  const last = [o.inAt, o.outAt].filter((d): d is Date => d != null);
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId: box,
      gmailThreadId: id,
      inInbox: true,
      category: o.category === undefined ? "customer_question" : o.category,
      priority: o.priority ?? "normal",
      needsOwner: o.needsOwner ?? false,
      needsOwnerSince: o.needsOwner ? (o.inAt ?? null) : null,
      lastMessageAt: last.length ? new Date(Math.max(...last.map((d) => d.getTime()))) : null,
      extracted: { urgency: o.urgency ?? "normal", ...o.extracted },
    })
    .returning();
  if (o.inAt)
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId: box,
      gmailMessageId: `${id}-in`,
      direction: "in",
      fromAddress: `c${n}@customer.com`,
      sentAt: o.inAt,
    });
  if (o.outAt)
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId: box,
      gmailMessageId: `${id}-out`,
      direction: "out",
      fromAddress: "owner@shop.com",
      toAddresses: [`c${n}@customer.com`],
      labelIds: ["SENT"],
      sentAt: o.outAt,
    });
  return t!.id;
}

describe("Inbox order (Check 10 P3)", () => {
  it("the SQL order matches inboxRank on a mixed set", async () => {
    const pipe = await seedThread({ urgency: "emergency", priority: "high", inAt: ago(3) });
    const answeredPipe = await seedThread({
      urgency: "emergency",
      priority: "high",
      inAt: ago(5),
      outAt: ago(4),
    });
    const oldPipe = await seedThread({ urgency: "emergency", priority: "high", inAt: ago(30) });
    const complaint = await seedThread({ category: "complaint", needsOwner: true, inAt: ago(1) });
    const urgent = await seedThread({ priority: "high", inAt: ago(6) });
    const plain = await seedThread({ inAt: ago(2) });
    const noTime = await seedThread({ inAt: null });
    const rows = await listInboxThreads(workspaceId, { kind: "all" }, { now: NOW });
    const ids = rows.map((r) => r.id);
    // The answered emergency is still urgent today (tier 1), and newer than the other one.
    expect(ids.slice(0, 4)).toEqual([pipe, complaint, answeredPipe, urgent]);
    expect(ids.slice(4, 6)).toEqual([plain, oldPipe]);
    expect(ids.at(-1)).toBe(noTime);
    expect(rows.find((r) => r.id === pipe)!.urgency).toBe("emergency");

    // The same order from the pure rule.
    const byRule = [...rows]
      .map((r) => ({
        id: r.id,
        urgency: r.urgency,
        priority: r.priority,
        needsOwner: r.needsOwner,
        lastMessageAt: r.lastMessageAt,
        lastIn: r.lastMessageAt && r.replyState !== "Replied" ? r.lastMessageAt : null,
        lastOut: r.replyState === "Replied" ? r.lastMessageAt : null,
      }))
      .sort((a, b) => compareInbox(a, b, NOW))
      .map((r) => r.id);
    expect(ids).toEqual(byRule);
    expect(ids).toEqual(expect.arrayContaining([answeredPipe, oldPipe, plain]));
  });
});
