import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { businessProfiles, threads } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";

/** Milestone 8 foundation: one additive migration (0025), no backfill, no enum changes. */
const M8 = "0025_m8_alerts_monthly";

describe("migration 0025 (plan M8 foundation)", () => {
  const statements = readFileSync(join("drizzle", `${M8}.sql`), "utf8")
    .split("--> statement-breakpoint")
    .map((s) =>
      s
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean);

  it("only adds nullable columns (prod and previews share one database)", () => {
    expect(statements.sort()).toEqual(
      [
        `ALTER TABLE "business_profile" ADD COLUMN "monthly_summary_last_sent_for" text;`,
        `ALTER TABLE "threads" ADD COLUMN "at_risk_alerted_at" timestamp with time zone;`,
        `ALTER TABLE "threads" ADD COLUMN "job_kind" text;`,
        `ALTER TABLE "threads" ADD COLUMN "quote_requested_at" timestamp with time zone;`,
      ].sort(),
    );
  });

  it("comes right after M7's complaint backfill in the journal", () => {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    const i = journal.entries.findIndex((e) => e.tag === M8);
    expect(journal.entries[i - 1]!.tag).toBe("0024_complaint_backfill");
    expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
  });
});

describe("M8 columns", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;

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

  it("start empty and round-trip", async () => {
    const [t] = await database
      .insert(threads)
      .values({ mailboxId, gmailThreadId: "t1" })
      .returning();
    expect(t).toMatchObject({ quoteRequestedAt: null, jobKind: null, atRiskAlertedAt: null });
    const when = new Date("2026-10-07T15:00:00Z");
    await database
      .update(threads)
      .set({ quoteRequestedAt: when, jobKind: "Panel upgrades", atRiskAlertedAt: when })
      .where(eq(threads.id, t!.id));
    const [row] = await database.select().from(threads).where(eq(threads.id, t!.id));
    expect(row).toMatchObject({
      quoteRequestedAt: when,
      jobKind: "Panel upgrades",
      atRiskAlertedAt: when,
    });

    await database.insert(businessProfiles).values({ workspaceId }).onConflictDoNothing();
    const [p] = await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId));
    expect(p!.monthlySummaryLastSentFor).toBeNull();
    await database
      .update(businessProfiles)
      .set({ monthlySummaryLastSentFor: "2026-09" })
      .where(eq(businessProfiles.workspaceId, workspaceId));
    const [p2] = await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId));
    expect(p2!.monthlySummaryLastSentFor).toBe("2026-09");
  });
});
