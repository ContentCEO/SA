import { randomBytes } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { invites, users, workspaces } from "@/db/schema";
import {
  accountSearch,
  adminOverview,
  countInvites,
  countWorkspaces,
  listInvites,
  pageNumber,
} from "@/server/admin";
import { createTestDb } from "../support/db";

/** Check 16 P5: every account can be reached and found, not just the newest 50. */

const T0 = Date.UTC(2026, 0, 1);
let database: Database;

async function seed(n: number) {
  const us = await database
    .insert(users)
    .values(Array.from({ length: n }, (_, i) => ({ email: `owner${i}@shop${i}.com` })))
    .returning({ id: users.id, email: users.email });
  await database.insert(workspaces).values(
    us.map((u, i) => ({
      ownerUserId: u.id,
      businessName: i === 7 ? "Ruiz Street Plumbing" : i === 8 ? "100% Electric" : `Shop ${i}`,
      createdAt: new Date(T0 + i * 60_000),
    })),
  );
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  vi.unstubAllEnvs();
  database = await createTestDb();
});

describe("paging and finding accounts (Check 16 P5)", () => {
  it("120 workspaces: page 3 returns the oldest 20", async () => {
    await seed(120);
    expect(await countWorkspaces()).toBe(120);
    const p1 = await adminOverview(new Date(), { page: 1 });
    const p3 = await adminOverview(new Date(), { page: 3 });
    expect(p1).toHaveLength(50);
    expect(p3).toHaveLength(20);
    expect(p1[0]!.businessName).toBe("Shop 119");
    expect(p3.at(-1)!.businessName).toBe("Shop 0");
    const all = new Set(
      [...p1, ...(await adminOverview(new Date(), { page: 2 })), ...p3].map((r) => r.workspaceId),
    );
    expect(all.size).toBe(120);
  });

  it("q finds a shop by part of its name or email, any case; % is literal", async () => {
    await seed(12);
    const byName = await adminOverview(new Date(), { q: "ruiz street" });
    expect(byName.map((r) => r.businessName)).toEqual(["Ruiz Street Plumbing"]);
    const byEmail = await adminOverview(new Date(), { q: "OWNER7@SHOP7" });
    expect(byEmail.map((r) => r.businessName)).toEqual(["Ruiz Street Plumbing"]);
    expect(await countWorkspaces("ruiz")).toBe(1);
    // "%" is a literal percent sign, not "anything".
    expect((await adminOverview(new Date(), { q: "100%" })).map((r) => r.businessName)).toEqual([
      "100% Electric",
    ]);
    expect(await adminOverview(new Date(), { q: "%" })).toHaveLength(1);
    expect(await adminOverview(new Date(), { q: "_" })).toHaveLength(0);
    expect(accountSearch("   ")).toBeUndefined();
  });

  it("Davi's own account is pinned on page 1 only (and only when it matches the search)", async () => {
    await seed(60);
    vi.stubEnv("ADMIN_EMAIL", "owner0@shop0.com");
    expect((await adminOverview(new Date(), { page: 1 }))[0]!.ownerEmail).toBe("owner0@shop0.com");
    const p2 = await adminOverview(new Date(), { page: 2 });
    expect(p2.filter((r) => r.ownerEmail === "owner0@shop0.com")).toHaveLength(1); // its own place
    expect((await adminOverview(new Date(), { q: "ruiz" })).map((r) => r.ownerEmail)).toEqual([
      "owner7@shop7.com",
    ]);
  });

  it("invites page the same way", async () => {
    await database.insert(invites).values(
      Array.from({ length: 55 }, (_, i) => ({
        email: `i${i}@x.com`,
        invitedAt: new Date(T0 + i * 1000),
      })),
    );
    expect(await countInvites()).toBe(55);
    expect(await listInvites()).toHaveLength(50);
    expect((await listInvites({ page: 2 })).map((i) => i.email)).toEqual(
      Array.from({ length: 5 }, (_, i) => `i${4 - i}@x.com`),
    );
  });

  it("odd page values are page 1", () => {
    expect(pageNumber("3")).toBe(3);
    for (const v of [undefined, "", "0", "-2", "abc", "1e9", ["2"]]) expect(pageNumber(v)).toBe(1);
  });
});
