import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { referralCredits, workspaces } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { createTestDb } from "../support/db";

/** Plan #47 offer A: one additive migration (0044; written as 0028, renumbered at each merge). Previews and production share one database. */
const TAG = "0044_referral_free_month";

const statements = readFileSync(join("drizzle", `${TAG}.sql`), "utf8")
  .split("--> statement-breakpoint")
  .map((s) =>
    s
      .split("\n")
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .trim(),
  )
  .filter(Boolean);

describe(`migration ${TAG} (referral free month)`, () => {
  it("is additive: nullable or defaulted columns and two partial unique indexes only", () => {
    const text = statements.join("\n");
    expect(text).not.toMatch(
      /\bDROP\b|\bRENAME\b|SET NOT NULL|ALTER COLUMN|\bUPDATE\b|\bDELETE\b/i,
    );
    for (const s of statements) {
      const add = /^ALTER TABLE "(\w+)" ADD COLUMN "(\w+)" ([^;]+);$/.exec(s);
      if (add) {
        // NOT NULL only together with a DEFAULT, so old rows and old code's inserts still work.
        if (/NOT NULL/.test(add[3]!)) expect(add[3]).toMatch(/DEFAULT/);
        continue;
      }
      expect(s).toMatch(
        /^CREATE UNIQUE INDEX "referral_credits_one_(scheduled|running)_uq" ON "referral_credits" USING btree \("beneficiary_workspace_id"\) WHERE status = '(scheduled|running)';$/,
      );
    }
    expect(statements.filter((s) => s.startsWith("CREATE UNIQUE INDEX"))).toHaveLength(2);
  });

  it("adds the columns the design names", () => {
    const added = statements
      .map((s) => /^ALTER TABLE "(\w+)" ADD COLUMN "(\w+)"/.exec(s))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => `${m[1]}.${m[2]}`)
      .sort();
    expect(added).toEqual(
      [
        "mailboxes.paused_reason",
        "workspaces.free_plan",
        "workspaces.free_plan_until",
        "workspaces.stripe_cancel_at",
        ...[
          "reward",
          "stripe_mode",
          "skip_reason",
          "stripe_subscription_id",
          "stripe_coupon_id",
          "stripe_discount_id",
          "stripe_invoice_id",
          "attached_at",
          "invoice_final_at",
          "claimed_at",
          "plan_change_seq",
          "paid_plan",
          "paid_price_id",
          "paid_price_cents",
          "free_plan",
          "starts_at",
          "ends_at",
          "kept_at",
          "kept_price_cents",
          "ended_at",
          "billing_mode",
          "admin_flag",
          "flagged_at",
        ].map((c) => `referral_credits.${c}`),
      ].sort(),
    );
  });

  it("comes right after wave 1's last migration, later than every earlier one", () => {
    const journal = JSON.parse(readFileSync("drizzle/meta/_journal.json", "utf8")) as {
      entries: { tag: string; when: number }[];
    };
    const i = journal.entries.findIndex((e) => e.tag === TAG);
    expect(journal.entries[i - 1]!.tag).toBe("0043_fallback_calls");
    // Drizzle's migrator runs only migrations newer than the last one applied (by `when`), and
    // 0032–0043 may already be on the shared database: 0044 must be later than all.
    for (const e of journal.entries.slice(0, i))
      expect(journal.entries[i]!.when, e.tag).toBeGreaterThan(e.when);
    // Then 0045, the follow-up marker, and nothing else yet.
    expect(journal.entries.slice(i + 1).map((e) => e.tag)).toEqual([AFTER_END_TAG]);
    expect(journal.entries[i + 1]!.when).toBeGreaterThan(journal.entries[i]!.when);
  });
});

/** The Stripe follow-up after a free month ends is retried until it goes through (0045). */
const AFTER_END_TAG = "0045_referral_after_end_check";

describe(`migration ${AFTER_END_TAG}`, () => {
  it("adds one nullable column and nothing else", () => {
    const text = readFileSync(join("drizzle", `${AFTER_END_TAG}.sql`), "utf8").trim();
    expect(text).toBe(
      'ALTER TABLE "referral_credits" ADD COLUMN "after_end_checked_at" timestamp with time zone;',
    );
  });
});

describe("referral free-month columns", () => {
  let database: Database;
  let workspaceId: string;

  beforeEach(async () => {
    database = await createTestDb();
    workspaceId = (await ensureUserAndWorkspace({ email: "rosa@gmail.com" })).workspace.id;
  });

  const row = (n: number, over: Partial<typeof referralCredits.$inferInsert> = {}) => ({
    referredEmailSha256: String(n).repeat(64).slice(0, 64),
    beneficiaryWorkspaceId: workspaceId,
    side: "referrer" as const,
    amountCents: 0,
    ...over,
  });

  it("an old-shaped insert still works and reads as a legacy balance credit", async () => {
    const [r] = await database.insert(referralCredits).values(row(1)).returning();
    expect(r).toMatchObject({
      reward: "balance_credit",
      status: "pending",
      planChangeSeq: 0,
      stripeMode: null,
      freePlan: null,
      adminFlag: null,
    });
    const [w] = await database.select().from(workspaces).where(eq(workspaces.id, workspaceId));
    expect(w).toMatchObject({ freePlan: null, freePlanUntil: null, stripeCancelAt: null });
  });

  it("allows many waiting rewards but only one booked and one running per workspace", async () => {
    await database
      .insert(referralCredits)
      .values([row(1, { reward: "free_month_up" }), row(2, { reward: "free_month_up" })]);
    for (const status of ["scheduled", "running"] as const) {
      await database
        .insert(referralCredits)
        .values(row(status === "scheduled" ? 3 : 4, { reward: "free_month_up", status }));
      const second = await database
        .insert(referralCredits)
        .values(row(status === "scheduled" ? 5 : 6, { reward: "free_month_up", status }))
        .then(
          () => null,
          (err: unknown) => err,
        );
      expect(second).not.toBeNull();
    }
    // Done rows don't count: free, paid, free.
    await database
      .insert(referralCredits)
      .values([row(7, { status: "done" }), row(8, { status: "done" })]);
    expect(await database.select().from(referralCredits)).toHaveLength(6);
  });

  it("mailboxes.paused_reason is kept for its migration but nothing reads or writes it", () => {
    // Since the referral merge (2026-10-17) the plan pause is `plan_paused_at`
    // (src/server/mailbox-plan.ts). A second pause flag would split every "is it on?" gate.
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory()
          ? files(join(dir, e.name))
          : /\.tsx?$/.test(e.name)
            ? [join(dir, e.name)]
            : [],
      );
    const users = files("src")
      .filter((f) => f !== join("src", "db", "schema.ts"))
      .filter((f) =>
        /pausedReason|paused_reason|MAILBOX_PAUSED_REASONS/.test(readFileSync(f, "utf8")),
      );
    expect(users).toEqual([]);
  });
});
