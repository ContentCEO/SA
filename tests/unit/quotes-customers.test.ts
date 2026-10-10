import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { messages, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { customerByKey, customerDetail, listCustomers } from "@/server/customers";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { amountFromOwnerText, formatCents, parseDollars, quoteStage } from "@/server/quote-rules";
import { captureQuoteAmounts, listQuotes, setQuoteOutcome } from "@/server/quotes";
import { createTestDb } from "../support/db";

const DAY = 86_400_000;
const NOW = new Date("2026-10-10T14:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

describe("quote rules", () => {
  const f = (o: Partial<Parameters<typeof quoteStage>[0]>) => ({
    outcome: null,
    lastInboundAt: daysAgo(5),
    lastOutboundAt: null,
    ...o,
  });
  it("works out where each quote stands", () => {
    expect(quoteStage(f({}), NOW, 3)).toBe("waiting_on_you");
    expect(quoteStage(f({ lastOutboundAt: daysAgo(1) }), NOW, 3)).toBe("talking");
    expect(quoteStage(f({ lastOutboundAt: daysAgo(4) }), NOW, 3)).toBe("quiet");
    expect(quoteStage(f({ lastOutboundAt: daysAgo(4), lastInboundAt: daysAgo(1) }), NOW, 3)).toBe(
      "waiting_on_you",
    );
    expect(quoteStage(f({ outcome: "won" }), NOW, 3)).toBe("won");
    expect(quoteStage(f({ outcome: "lost", lastOutboundAt: daysAgo(9) }), NOW, 3)).toBe("lost");
  });
  it("reads the quoted amount from the owner's words", () => {
    expect(amountFromOwnerText("It's $2,400 incl. permit, $150 deposit")).toBe(240_000);
    expect(amountFromOwnerText("about $3.5k all in")).toBe(350_000);
    expect(amountFromOwnerText("I'll come take a look")).toBeNull();
    expect(formatCents(145_000)).toBe("$1,450");
    expect(formatCents(145_050)).toBe("$1,450.50");
    expect(parseDollars("$1,450")).toBe(145_000);
    expect(parseDollars("abc")).toBeNull();
    expect(parseDollars("")).toBeNull();
  });
});

let database: Database;
let workspaceId: string;
let mailboxId: string;
let g = 0;

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

async function convo(opts: {
  from: string;
  name: string;
  category: string;
  inAgo: number;
  outAgo?: number;
  reply?: string;
}) {
  const id = `g${++g}`;
  const last = Math.min(opts.inAgo, opts.outAgo ?? Infinity);
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: id,
      inInbox: true,
      subject: "Job",
      category: opts.category,
      summary: `${opts.name} wants something.`,
      lastMessageAt: daysAgo(last),
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: `${id}-in`,
    direction: "in",
    fromAddress: opts.from,
    fromName: opts.name,
    bodyText: "Can you quote it?",
    sentAt: daysAgo(opts.inAgo),
  });
  if (opts.outAgo !== undefined) {
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: `${id}-out`,
      direction: "out",
      fromAddress: "owner@shop.com",
      bodyText: opts.reply ?? "Sure.",
      sentAt: daysAgo(opts.outAgo),
    });
  }
  return t!.id;
}

describe("quote tracker", () => {
  it("lists quotes with stages, amounts and 30-day totals", async () => {
    await convo({ from: "dana@x.com", name: "Dana Ruiz", category: "quote_request", inAgo: 2 });
    const quiet = await convo({
      from: "Priya@Y.com",
      name: "Priya",
      category: "quote_request",
      inAgo: 8,
      outAgo: 6,
      reply: "Hi Priya, $2,400 for the panel.\n\nOn Mon, Priya wrote:\n> is $5,000 ok?",
    });
    const won = await convo({
      from: "sam@z.com",
      name: "Sam",
      category: "quote_request",
      inAgo: 10,
      outAgo: 9,
      reply: "$900 total.",
    });
    await convo({ from: "ads@spam.com", name: "Ads", category: "noise", inAgo: 1 });

    expect(await setQuoteOutcome(workspaceId, won, "won", undefined, NOW)).toBe(true);
    const { quotes, totals } = await listQuotes(workspaceId, NOW);
    expect(quotes).toHaveLength(3);
    const by = Object.fromEntries(quotes.map((q) => [q.threadId, q]));
    expect(by[quiet]!.stage).toBe("quiet");
    expect(by[quiet]!.amountCents).toBe(240_000); // the customer's quoted $5,000 is ignored
    expect(by[won]!.stage).toBe("won");
    expect(totals).toMatchObject({
      requests: 3,
      quotedCount: 2,
      quotedCents: 330_000,
      wonCount: 1,
      wonCents: 90_000,
      winRatePct: 100,
    });
  });

  it("keeps the amount after the reply text is purged, and lets the owner correct it", async () => {
    const t = await convo({
      from: "dana@x.com",
      name: "Dana",
      category: "quote_request",
      inAgo: 3,
      outAgo: 2,
      reply: "That's $1,200.",
    });
    expect(await captureQuoteAmounts()).toBe(1);
    await database.update(messages).set({ bodyText: null }).where(eq(messages.threadId, t));
    await captureQuoteAmounts();
    expect((await listQuotes(workspaceId, NOW)).quotes[0]!.amountCents).toBe(120_000);
    await setQuoteOutcome(workspaceId, t, "won", 135_000, NOW);
    expect((await listQuotes(workspaceId, NOW)).quotes[0]!.amountCents).toBe(135_000);
    await setQuoteOutcome(workspaceId, t, null, undefined, NOW); // reopen
    expect((await listQuotes(workspaceId, NOW)).quotes[0]!.stage).toBe("talking");
  });

  it("can't touch another workspace's thread", async () => {
    const t = await convo({ from: "d@x.com", name: "D", category: "quote_request", inAgo: 1 });
    const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
    expect(await setQuoteOutcome(other.id, t, "won")).toBe(false);
    expect((await listQuotes(other.id, NOW)).quotes).toHaveLength(0);
  });
});

describe("customer list", () => {
  it("groups by sender (case-insensitive), leaves out noise, and adds quote facts", async () => {
    const q = await convo({
      from: "Dana@X.com",
      name: "Dana Ruiz",
      category: "quote_request",
      inAgo: 5,
      outAgo: 4,
      reply: "$700",
    });
    await convo({ from: "dana@x.com", name: "Dana Ruiz", category: "scheduling", inAgo: 1 });
    await convo({
      from: "rep@supply.com",
      name: "Supply Co",
      category: "supplier_vendor",
      inAgo: 2,
    });
    await convo({ from: "ads@spam.com", name: "Ads", category: "noise", inAgo: 1 });
    await setQuoteOutcome(workspaceId, q, "won", undefined, NOW);

    const list = await listCustomers(workspaceId, NOW);
    expect(list.map((c) => c.address)).toEqual(["dana@x.com", "rep@supply.com"]);
    expect(list[0]).toMatchObject({ name: "Dana Ruiz", conversations: 2, wonCents: 70_000 });
    expect(list[1]!.isSupplier).toBe(true);

    const d = await customerDetail(workspaceId, "DANA@x.com");
    expect(d!.threads).toHaveLength(2);
    expect(d!.name).toBe("Dana Ruiz");
    expect(await customerDetail(workspaceId, "ads@spam.com")).toMatchObject({ threads: [] });
    expect(await customerDetail(workspaceId, "nobody@x.com")).toBeNull();
    expect((await customerByKey(workspaceId, list[0]!.key))!.address).toBe("dana@x.com");
    expect(await customerByKey(workspaceId, "not-a-key")).toBeNull();
  });

  it("never shows another workspace's customers", async () => {
    await convo({ from: "dana@x.com", name: "Dana", category: "quote_request", inAgo: 1 });
    const { workspace: other } = await ensureUserAndWorkspace({ email: "other@shop.com" });
    expect(await listCustomers(other.id, NOW)).toEqual([]);
    expect(await customerDetail(other.id, "dana@x.com")).toBeNull();
    const [mine] = await listCustomers(workspaceId, NOW);
    expect(await customerByKey(other.id, mine!.key)).toBeNull();
  });
});
