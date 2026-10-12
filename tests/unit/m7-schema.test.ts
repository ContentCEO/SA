import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import * as schema from "@/db/schema";
import { drafts, mailboxes, messages, priceHistory, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";

/** Milestone 7 foundation: one additive migration (0023) for every new column and table. */
const M7 = "0023_solid_slyde";
/** A1 follow-up: data-only backfill of the sticky complaint mark. */
const BACKFILL = "0024_complaint_backfill";

describe("migration 0023 (plan M7 foundation)", () => {
  const sqlText = readFileSync(join("drizzle", `${M7}.sql`), "utf8");

  it("is additive only (prod and previews share one database)", () => {
    const statements = sqlText
      .split("--> statement-breakpoint")
      .map((s) =>
        s
          .split("\n")
          .filter((l) => !l.trim().startsWith("--"))
          .join("\n")
          .trim(),
      )
      .filter(Boolean);
    for (const st of statements) {
      expect(st, st).not.toMatch(
        /\bDROP\b|\bRENAME\b|SET NOT NULL|ALTER COLUMN|TRUNCATE|^\s*DELETE\b/im,
      );
      expect(st, st).toMatch(
        /^(CREATE TABLE|CREATE (UNIQUE )?INDEX|ALTER TABLE "\w+" ADD (COLUMN "\w+" (text|timestamp with time zone);|CONSTRAINT)|UPDATE "threads" SET "quote_outcome_source" = 'owner' WHERE)/,
      );
    }
    // Every new column is nullable.
    for (const col of sqlText.matchAll(/ADD COLUMN "(\w+)" ([^;]+);/g)) {
      expect(col[2], col[1]).not.toMatch(/NOT NULL/);
    }
  });

  it("is followed in the journal by the complaint backfill", () => {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
      entries: { tag: string }[];
    };
    const tags = journal.entries.map((e) => e.tag);
    expect(tags.slice(tags.indexOf(M7), tags.indexOf(M7) + 2)).toEqual([M7, BACKFILL]);
  });

  it("the backfill (0024) only fills complained_at on complaint threads that lack it", () => {
    const backfill = readFileSync(join("drizzle", `${BACKFILL}.sql`), "utf8")
      .split("\n")
      .filter((l) => l.trim() && !l.trim().startsWith("--"))
      .join("\n")
      .trim();
    expect(backfill).toBe(
      `UPDATE "threads" SET "complained_at" = coalesce("classified_at", "last_message_at", now()) WHERE "category" = 'complaint' AND "complained_at" IS NULL;`,
    );
  });

  describe("marks Won/Lost set before it as the owner's (amendment A13)", () => {
    const dirs: string[] = [];
    afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

    it("existing outcomes get source 'owner'; open quotes stay null", async () => {
      // A copy of /drizzle that stops just before 0023.
      const before = mkdtempSync(join(tmpdir(), "sa-m7-"));
      dirs.push(before);
      cpSync("drizzle", before, { recursive: true });
      const journalPath = join(before, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        entries: { tag: string }[];
      };
      const from = journal.entries.findIndex((e) => e.tag === M7);
      for (const e of journal.entries.slice(from)) rmSync(join(before, `${e.tag}.sql`));
      journal.entries = journal.entries.slice(0, from);
      writeFileSync(journalPath, JSON.stringify(journal));
      expect(readdirSync(before).some((f) => f.startsWith("0023"))).toBe(false);

      const client = new PGlite();
      const database = drizzle(client, { schema });
      await migrate(database, { migrationsFolder: before });

      // Rows as the old code wrote them (raw SQL: the new columns don't exist yet).
      await client.exec(`
        INSERT INTO users (id, email) VALUES ('00000000-0000-0000-0000-000000000001', 'o@shop.com');
        INSERT INTO workspaces (id, owner_user_id) VALUES
          ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001');
        INSERT INTO mailboxes (id, workspace_id, email, encrypted_refresh_token, scopes) VALUES
          ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000002', 'o@shop.com', 'x', '');
        INSERT INTO threads (mailbox_id, gmail_thread_id, quote_outcome, quote_outcome_at) VALUES
          ('00000000-0000-0000-0000-000000000003', 'won', 'won', now()),
          ('00000000-0000-0000-0000-000000000003', 'lost', 'lost', now()),
          ('00000000-0000-0000-0000-000000000003', 'open', NULL, NULL);
        INSERT INTO threads (mailbox_id, gmail_thread_id, category, classified_at, last_message_at) VALUES
          ('00000000-0000-0000-0000-000000000003', 'complaint', 'complaint', '2026-09-01T12:00:00Z', '2026-09-02T12:00:00Z'),
          ('00000000-0000-0000-0000-000000000003', 'complaint-unsorted-time', 'complaint', NULL, '2026-09-03T12:00:00Z'),
          ('00000000-0000-0000-0000-000000000003', 'question', 'customer_question', '2026-09-01T12:00:00Z', NULL);
      `);

      await migrate(database, { migrationsFolder: "./drizzle" });
      const rows = await database.select().from(threads);
      const by = Object.fromEntries(rows.map((t) => [t.gmailThreadId, t]));
      expect(by.won!.quoteOutcomeSource).toBe("owner");
      expect(by.lost!.quoteOutcomeSource).toBe("owner");
      expect(by.open!.quoteOutcomeSource).toBeNull();
      for (const t of rows) {
        expect(t.invoicePaidAt).toBeNull();
        expect(t.invoicePaidSource).toBeNull();
      }
      // 0024: complaints sorted before the sticky mark existed get it (A1); nothing else does.
      expect(by.complaint!.complainedAt).toEqual(new Date("2026-09-01T12:00:00Z"));
      expect(by["complaint-unsorted-time"]!.complainedAt).toEqual(new Date("2026-09-03T12:00:00Z"));
      for (const g of ["won", "lost", "open", "question"]) expect(by[g]!.complainedAt).toBeNull();
      await client.close();
    }, 60_000); // two full migration runs on PGlite
  });
});

describe("M7 columns and tables", () => {
  let database: Database;
  let mailboxId: string;
  let workspaceId: string;

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    workspaceId = workspace.id;
    const box = await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    mailboxId = box.id;
  });

  const newThread = async (g = "t1") => {
    const [t] = await database
      .insert(threads)
      .values({ mailboxId, gmailThreadId: g, inInbox: true })
      .returning();
    return t!;
  };
  const newDraft = (threadId: string, over: Partial<typeof drafts.$inferInsert> = {}) =>
    database
      .insert(drafts)
      .values({
        threadId,
        mailboxId,
        toAddress: "dana@example.com",
        subject: "Re: deck",
        reason: "r",
        ...over,
      })
      .returning();

  it("new thread columns default to empty (nothing owed, decided or complained)", async () => {
    const t = await newThread();
    expect(t).toMatchObject({
      quoteOutcomeSource: null,
      invoicePaidAt: null,
      invoicePaidSource: null,
      complainedAt: null,
    });
    const [d] = await newDraft(t.id);
    expect(d!.purpose).toBeNull();
    expect(d!.kind).toBe("reply");
  });

  it("asks the closing question once per thread, ever — whatever happened to the first one", async () => {
    const t = await newThread();
    const [first] = await newDraft(t.id, { purpose: "closing_question" });
    await database.update(drafts).set({ status: "discarded" }).where(eq(drafts.id, first!.id));
    await expect(newDraft(t.id, { purpose: "closing_question" })).rejects.toThrow();

    // Other purposes and other threads are unaffected.
    const [deposit] = await newDraft(t.id, { purpose: "deposit" });
    expect(deposit!.purpose).toBe("deposit");
    await database.update(drafts).set({ status: "sent" }).where(eq(drafts.id, deposit!.id));
    const [review] = await newDraft(t.id, { purpose: "review_request" });
    await database.update(drafts).set({ status: "sent" }).where(eq(drafts.id, review!.id));
    await newDraft(t.id, { purpose: "review_request" });
    const other = await newThread("t2");
    await expect(newDraft(other.id, { purpose: "closing_question" })).resolves.toHaveLength(1);
  });

  it("still allows only one pending draft per thread, purpose or not", async () => {
    const t = await newThread();
    await newDraft(t.id, { purpose: "deposit" });
    await expect(newDraft(t.id)).rejects.toThrow();
  });

  it("price history: one row per thread, gone with the thread or the mailbox", async () => {
    const t = await newThread();
    const row = {
      workspaceId,
      threadId: t.id,
      service: "deck repair",
      amountCents: 180_000,
      quotedAt: new Date("2026-10-01T12:00:00Z"),
    };
    await database.insert(priceHistory).values(row);
    // Idempotent capture relies on the unique index.
    await database.insert(priceHistory).values(row).onConflictDoNothing();
    expect(await database.select().from(priceHistory)).toHaveLength(1);
    await expect(database.insert(priceHistory).values(row)).rejects.toThrow();

    await database.delete(threads).where(eq(threads.id, t.id));
    expect(await database.select().from(priceHistory)).toHaveLength(0);

    const t2 = await newThread("t2");
    await database.insert(priceHistory).values({ ...row, threadId: t2.id });
    await database.insert(messages).values({
      threadId: t2.id,
      mailboxId,
      gmailMessageId: "m1",
      direction: "out",
      sentAt: new Date(),
    });
    await database.delete(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(await database.select().from(priceHistory)).toHaveLength(0);
  });
});
