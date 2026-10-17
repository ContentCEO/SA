import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { gmailUnits, mailboxes } from "@/db/schema";
import { MailboxRateLimitError } from "@/mailbox/connector";
import { createGmailReader } from "@/mailbox/gmail/api";
import { GMAIL_UNITS, GMAIL_UNITS_PER_MINUTE } from "@/mailbox/gmail/quota";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { gmailBudgetFor, purgeGmailUnits } from "@/server/gmail-units";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";

/** Check 25 P1: the per-mailbox Gmail unit budget. */
let database: Database;
let mailboxId: string;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AUTH_GOOGLE_ID = "id";
  process.env.AUTH_GOOGLE_SECRET = "secret";
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  const m = await saveConnectedMailbox(workspace, {
    email: "owner@shop.com",
    refreshToken: "rt",
    grantedScopes: ["x"],
  });
  mailboxId = m.id;
});

/** A Gmail that answers every request; counts the Gmail calls (token refreshes aside). */
function fakeGoogle() {
  const gmailCalls: string[] = [];
  const f = vi.fn(async (url: string) => {
    if (String(url).includes("/token")) return json({ access_token: "at", expires_in: 3600 });
    gmailCalls.push(String(url));
    if (String(url).includes("/profile")) return json({ emailAddress: "o@x.com", historyId: "1" });
    return json({ id: "m", threadId: "t", labelIds: ["INBOX"], internalDate: "0", payload: {} });
  });
  return { f, gmailCalls };
}

describe("Gmail unit budget", () => {
  it("adds reservations up per minute, and a new minute starts at zero", async () => {
    let now = new Date("2026-10-17T10:00:05Z");
    const budget = gmailBudgetFor(mailboxId, () => now);
    await budget.reserve("messages.get");
    await budget.reserve("messages.list");
    await budget.reserve("getProfile");
    let rows = await database.select().from(gmailUnits);
    expect(rows).toEqual([
      { mailboxId, minute: new Date("2026-10-17T10:00:00Z"), units: 20 + 5 + 1 },
    ]);
    now = new Date("2026-10-17T10:01:00Z");
    await budget.reserve("history.list");
    rows = await database
      .select()
      .from(gmailUnits)
      .where(eq(gmailUnits.minute, new Date("2026-10-17T10:01:00Z")));
    expect(rows[0]!.units).toBe(GMAIL_UNITS["history.list"]);
  });

  it("refuses a call that would pass 5,400 with retryAt at the next minute, and makes no fetch", async () => {
    const now = new Date("2026-10-17T10:00:30Z");
    await database
      .insert(gmailUnits)
      .values({ mailboxId, minute: new Date("2026-10-17T10:00:00Z"), units: 5_390 });
    const { f, gmailCalls } = fakeGoogle();
    const r = createGmailReader({
      refreshToken: "rt",
      fetchImpl: f as unknown as typeof fetch,
      mailboxId,
      budget: gmailBudgetFor(mailboxId, () => now),
    });
    // getProfile (1 unit) still fits; a message read (20) doesn't.
    await r.getProfile();
    const err = await r.getMessage("m", { withBody: true }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailboxRateLimitError);
    expect((err as MailboxRateLimitError).retryAt).toEqual(new Date("2026-10-17T10:01:00Z"));
    expect(gmailCalls).toHaveLength(1);
    const [row] = await database.select().from(gmailUnits);
    expect(row!.units).toBe(5_391); // the refused reservation wasn't counted
  });

  it("a cool-down Gmail named stops every call before any fetch", async () => {
    const now = new Date("2026-10-17T10:00:00Z");
    await database
      .update(mailboxes)
      .set({ gmailCoolUntil: new Date("2026-10-17T10:05:00Z") })
      .where(eq(mailboxes.id, mailboxId));
    const { f } = fakeGoogle();
    const r = createGmailReader({
      refreshToken: "rt",
      fetchImpl: f as unknown as typeof fetch,
      mailboxId,
      budget: gmailBudgetFor(mailboxId, () => now),
    });
    const err = await r.getProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailboxRateLimitError);
    expect((err as MailboxRateLimitError).retryAt).toEqual(new Date("2026-10-17T10:05:00Z"));
    expect(f).not.toHaveBeenCalled();
  });

  it("stores Gmail's own retry time so every job for the inbox waits together", async () => {
    const now = new Date("2026-10-17T10:00:00Z");
    const f = vi.fn(async (url: string) => {
      if (String(url).includes("/token")) return json({ access_token: "at" });
      return json(
        {
          error: {
            message: "User-rate limit exceeded. Retry after 2026-10-17T10:04:00.000Z",
            errors: [{ reason: "rateLimitExceeded" }],
          },
        },
        429,
      );
    });
    const r = createGmailReader({
      refreshToken: "rt",
      fetchImpl: f as unknown as typeof fetch,
      sleep: async () => {},
      mailboxId,
      budget: gmailBudgetFor(mailboxId, () => now),
    });
    await expect(r.getProfile()).rejects.toBeInstanceOf(MailboxRateLimitError);
    const [box] = await database.select().from(mailboxes);
    expect(box!.gmailCoolUntil).toEqual(new Date("2026-10-17T10:04:00Z"));
    // A second client (another job) stops before fetching.
    const { f: f2 } = fakeGoogle();
    const other = createGmailReader({
      refreshToken: "rt",
      fetchImpl: f2 as unknown as typeof fetch,
      mailboxId,
      budget: gmailBudgetFor(mailboxId, () => now),
    });
    await expect(other.getProfile()).rejects.toBeInstanceOf(MailboxRateLimitError);
    expect(f2).not.toHaveBeenCalled();
  });

  it("a simulated first read of 2,000 inbox emails never passes 5,400 units in any minute", async () => {
    let clock = new Date("2026-10-17T10:00:00Z").getTime();
    const { f, gmailCalls } = fakeGoogle();
    const r = createGmailReader({
      refreshToken: "rt",
      fetchImpl: f as unknown as typeof fetch,
      mailboxId,
      budget: gmailBudgetFor(mailboxId, () => new Date(clock)),
    });
    let read = 0;
    let pauses = 0;
    while (read < 2_000) {
      try {
        if (read % 50 === 0) await r.listMessages({ query: "in:inbox", maxResults: 50 });
        await r.getMessage(`m${read}`, { withBody: true });
        read++;
        clock += 20; // a fast Gmail: 50 reads a second if nothing held us back
      } catch (err) {
        expect(err).toBeInstanceOf(MailboxRateLimitError);
        clock = (err as MailboxRateLimitError).retryAt!.getTime(); // politely() waits
        pauses++;
      }
    }
    const rows = await database.select().from(gmailUnits);
    expect(Math.max(...rows.map((x) => x.units))).toBeLessThanOrEqual(GMAIL_UNITS_PER_MINUTE);
    expect(rows.reduce((a, x) => a + x.units, 0)).toBe(2_000 * 20 + 40 * 5);
    expect(gmailCalls).toHaveLength(2_000 + 40);
    expect(pauses).toBeGreaterThan(5);
  }, 240_000);

  it("purges minutes older than a day", async () => {
    const now = new Date("2026-10-17T10:00:00Z");
    await database.insert(gmailUnits).values([
      { mailboxId, minute: new Date("2026-10-15T10:00:00Z"), units: 5 },
      { mailboxId, minute: new Date("2026-10-17T09:59:00Z"), units: 5 },
    ]);
    await purgeGmailUnits(now);
    expect(await database.select().from(gmailUnits)).toHaveLength(1);
  });
});
