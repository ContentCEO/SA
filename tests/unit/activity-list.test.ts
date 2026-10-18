import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { activityLog } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  DESCRIBED_ACTIONS,
  HIDDEN_ON_PURPOSE,
  describeActivity,
  listActivityPage,
} from "@/server/activity";
import { activityCursorParam, parseActivityCursor } from "@/server/activity-rules";
import { createTestDb } from "../support/db";

/** A detail that makes each conditional case say its line. */
const DETAIL: Record<string, Record<string, unknown>> = {
  quote_outcome_guessed: { outcome: "won" },
  thread_resorted: { to: "quote_request" },
  test_payment_reset: { setupPaymentCleared: true },
  lead_at_risk_push_sent: { leads: 2 },
  emergency_alert_sent: { emergencies: 1 },
};

describe("DESCRIBED_ACTIONS (Check 14 P6)", () => {
  it("every listed action has a sentence", () => {
    for (const action of DESCRIBED_ACTIONS)
      expect(describeActivity(action, DETAIL[action] ?? {}, null), action).not.toBeNull();
  });

  it("every case in describeActivity is listed, or hidden on purpose", () => {
    const src = readFileSync(join(process.cwd(), "src/server/activity.ts"), "utf8");
    const body = src.slice(
      src.indexOf("export function describeActivity"),
      src.indexOf("export const DESCRIBED_ACTIONS"),
    );
    const cases = [...body.matchAll(/case "([a-z_]+)":/g)].map((m) => m[1]!);
    expect(cases.length).toBeGreaterThan(60);
    const known = new Set<string>([...DESCRIBED_ACTIONS, ...HIDDEN_ON_PURPOSE]);
    expect(cases.filter((c) => !known.has(c))).toEqual([]);
    // And nothing is in both lists.
    expect(
      DESCRIBED_ACTIONS.filter((a) => (HIDDEN_ON_PURPOSE as readonly string[]).includes(a)),
    ).toEqual([]);
  });

  it("hidden actions say nothing", () => {
    for (const action of HIDDEN_ON_PURPOSE) expect(describeActivity(action, {}, null)).toBeNull();
  });
});

/** Every `action: "x"` the code writes (including either side of a ternary). */
function loggedActions(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name)) {
        const src = readFileSync(path, "utf8");
        // `action: "x"` or `action: cond ? "x" : "y"` (never a call like text("action")).
        for (const m of src.matchAll(
          /\baction: (?:"([a-z_]+)"|[^,\n}?("]+\?\s*"([a-z_]+)"\s*:\s*"([a-z_]+)")/g,
        ))
          for (const lit of m.slice(1)) if (lit) out.add(lit);
      }
    }
  };
  walk(join(process.cwd(), "src"));
  return out;
}

describe("every logged action shows on Activity or is hidden on purpose (Check 14 P7)", () => {
  it("guard: no logged action falls to the default", () => {
    const known = new Set<string>([...DESCRIBED_ACTIONS, ...HIDDEN_ON_PURPOSE]);
    const logged = loggedActions();
    expect(logged.size).toBeGreaterThan(50);
    expect([...logged].filter((a) => !known.has(a)).sort()).toEqual([]);
  });

  it("the five owner actions that were missing now have plain lines", () => {
    const who = { name: "Dana Ruiz", category: "quote_request" };
    expect(describeActivity("answered_by_phone", { draftRemoved: false }, who)).toBe(
      "You marked that you called Dana",
    );
    expect(describeActivity("answered_by_phone", { draftRemoved: true }, who)).toBe(
      "You marked that you called Dana (the waiting draft was taken away)",
    );
    expect(describeActivity("answered_by_phone", { draftRemoved: false }, null)).toBe(
      "You marked a conversation as answered by phone",
    );
    expect(describeActivity("found_money_drafts_requested", { replies: 3, nudges: 2 }, null)).toBe(
      "You asked for drafts for 5 quotes that slipped",
    );
    expect(describeActivity("found_money_drafts_requested", { replies: 1, nudges: 0 }, null)).toBe(
      "You asked for drafts for 1 quote that slipped",
    );
    expect(describeActivity("first_drafts_ready_sent", { email: true, phones: 0 }, null)).toBe(
      "Told you your first drafts were ready",
    );
    expect(describeActivity("seasonal_note_added", {}, null)).toBe("You added a seasonal note");
    expect(describeActivity("never_say_saved", {}, null)).toBe("You updated your never-say list");
  });
});

describe("cursor param", () => {
  it("round-trips, and junk is the first page", () => {
    const c = {
      at: new Date("2026-10-14T12:00:00.123Z"),
      id: "5f0b1d0e-8f6a-4c1e-9a43-0d5c2a1b7e11",
    };
    expect(parseActivityCursor(activityCursorParam(c))).toEqual(c);
    for (const junk of [undefined, "", "x", "2026-10-14_nope", ["a"], `${"9".repeat(200)}`])
      expect(parseActivityCursor(junk)).toBeUndefined();
  });
});

describe("listActivityPage (Check 14 P6)", () => {
  let database: Database;
  let workspaceId: string;

  beforeEach(async () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    database = await createTestDb();
    ({
      workspace: { id: workspaceId },
    } = await ensureUserAndWorkspace({ email: "owner@shop.com" }));
  });

  it("150 described rows and 80 hidden ones: 100, then the next 50; hidden rows never count", async () => {
    const base = new Date("2026-10-14T12:00:00Z").getTime();
    const rows: (typeof activityLog.$inferInsert)[] = [];
    for (let i = 0; i < 150; i++)
      rows.push({
        workspaceId,
        actor: "owner",
        action: "vip_added",
        detail: { i },
        // Pairs share a millisecond, so ties on the page edge are tested too.
        createdAt: new Date(base - Math.floor(i / 2) * 60_000),
      });
    for (let i = 0; i < 80; i++)
      rows.push({
        workspaceId,
        actor: "owner",
        action: i % 2 ? "send_approved" : "checklist_dismissed",
        detail: {},
        createdAt: new Date(base - i * 30_000 + 1),
      });
    await database.insert(activityLog).values(rows);

    const first = await listActivityPage(workspaceId);
    expect(first.entries).toHaveLength(100);
    expect(first.entries.every((e) => e.text === "You added a VIP")).toBe(true);
    expect(first.older).not.toBeNull();
    const second = await listActivityPage(workspaceId, { before: first.older! });
    expect(second.entries).toHaveLength(50);
    expect(second.older).toBeNull();
    // Every described row exactly once across the pages, newest first.
    const ids = [...first.entries, ...second.entries].map((e) => e.id);
    expect(new Set(ids).size).toBe(150);
    const times = [...first.entries, ...second.entries].map((e) => e.at.getTime());
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it("only this workspace's rows, even with a cursor", async () => {
    const other = (await ensureUserAndWorkspace({ email: "other@shop.com" })).workspace.id;
    await database.insert(activityLog).values([
      { workspaceId: other, actor: "owner", action: "vip_added", detail: {} },
      { workspaceId, actor: "owner", action: "vip_added", detail: {} },
    ]);
    const page = await listActivityPage(workspaceId, {
      before: { at: new Date(Date.now() + 60_000), id: "ffffffff-ffff-4fff-bfff-ffffffffffff" },
    });
    expect(page.entries).toHaveLength(1);
  });

  it("a test-payment reset that changed nothing the owner can see isn't fetched", async () => {
    await database.insert(activityLog).values([
      { workspaceId, actor: "squared_away", action: "test_payment_reset", detail: {} },
      {
        workspaceId,
        actor: "squared_away",
        action: "test_payment_reset",
        detail: { setupPaymentCleared: true },
      },
    ]);
    const page = await listActivityPage(workspaceId, { limit: 1 });
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]!.text).toContain("test payment was cleared");
  });
});
