import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { portalCopy } from "@/components/growth-portal/portal-copy";
import { TERMS_VERSION } from "@/config/legal";
import type { Database } from "@/db";
import {
  growthClients,
  growthMonthly,
  growthUpdates,
  invites,
  users,
  waitlist,
  workspaces,
} from "@/db/schema";
import type { OutgoingEmail } from "@/lib/email";
import type { MailboxConnector } from "@/mailbox/connector";
import { deleteAccount } from "@/server/account-deletion";
import { ensureUserAndWorkspace, isAllowedToSignIn } from "@/server/accounts";
import {
  checkInMonthOk,
  growthMoveTarget,
  localDayStart,
  monthKeyOf,
  parseCheckIn,
  parseCount,
  parseMoneyCents,
  parseUpdate,
  periodMetrics,
  portalOpen,
  recentMonths,
  startDateOk,
  sumCheckIns,
  type CheckInRow,
} from "@/server/growth-client-rules";
import {
  growthDashboard,
  growthStateForEmails,
  inviteToGrowth,
  listGrowthAdmin,
  moveGrowthClient,
  notifyGrowthUpdate,
  portalClient,
  postGrowthUpdate,
  removeGrowthRequest,
  saveGrowthMonth,
  sendGrowthInviteEmail,
  startGrowth,
} from "@/server/growth-clients";
import { formatGrowthBlock, splitWaitlistNote, withoutGrowthBlocks } from "@/server/growth-note";
import { createTestDb } from "../support/db";

/**
 * Squared Away Growth clients (Davi, 2026-10-16): the portal's gates, its numbers (only what
 * Davi entered — Growth never uses inbox data), the update email, the Remove button and the
 * deletion cascade.
 */

const ADMIN = "davi-admin@example.com";
const NOW = new Date("2026-10-16T15:00:00Z");

const session = vi.hoisted(() => ({ email: null as string | null, id: "" }));
vi.mock("@/auth", () => ({
  auth: async () => (session.email ? { user: { id: session.id, email: session.email } } : null),
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
class Redirected extends Error {
  constructor(readonly url: string) {
    super("redirect");
  }
}
class NotFound extends Error {}
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  redirect: (url: string) => {
    throw new Redirected(url);
  },
  notFound: () => {
    throw new NotFound("not found");
  },
}));
const sendEmail = vi.fn<(e: OutgoingEmail) => Promise<"sent" | "not_configured">>();
vi.mock("@/lib/email", async (orig) => ({
  ...(await orig<typeof import("@/lib/email")>()),
  sendEmail: (e: OutgoingEmail) => sendEmail(e),
}));

const actions = await import("@/app/(app)/admin/growth-actions");
const { default: StartPage } = await import("@/app/start/page");
const { default: MyGrowthPage } = await import("@/app/my-growth/page");

let database: Database;
beforeEach(async () => {
  database = await createTestDb();
  vi.stubEnv("ADMIN_EMAIL", ADMIN);
  vi.stubEnv("AUTH_SECRET", "test-secret");
  sendEmail.mockReset();
  sendEmail.mockResolvedValue("sent");
  session.email = null;
});
afterEach(() => {
  vi.unstubAllEnvs();
});

async function owner(email: string) {
  const [u] = await database
    .insert(users)
    .values({ email, termsAcceptedAt: NOW, termsVersion: TERMS_VERSION })
    .returning();
  const [w] = await database.insert(workspaces).values({ ownerUserId: u!.id }).returning();
  return { userId: u!.id, workspaceId: w!.id, email };
}
const as = (o: { userId: string; email: string }) => {
  session.email = o.email;
  session.id = o.userId;
};
async function client(workspaceId: string, over: Partial<typeof growthClients.$inferInsert> = {}) {
  const [c] = await database
    .insert(growthClients)
    .values({ workspaceId, startedOn: "2026-09-10", services: ["google_ads"], ...over })
    .returning();
  return c!;
}
const form = (fields: Record<string, string | string[]>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields))
    for (const one of Array.isArray(v) ? v : [v]) fd.append(k, one);
  return fd;
};
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof Redirected) return err.url;
    throw err;
  }
  throw new Error("no redirect");
}
const row = (month: string, over: Partial<CheckInRow> = {}): CheckInRow => ({
  month,
  newLeads: null,
  calls: null,
  jobsWon: null,
  moneyWonCents: null,
  reviewsGained: null,
  adSpendCents: null,
  ...over,
});

describe("rules", () => {
  it("only active and paused clients see the portal; moves only go where they may", () => {
    expect([
      portalOpen("active"),
      portalOpen("paused"),
      portalOpen("ended"),
      portalOpen(null),
    ]).toEqual([true, true, false, false]);
    expect(growthMoveTarget("active", "pause")).toBe("paused");
    expect(growthMoveTarget("paused", "resume")).toBe("active");
    expect(growthMoveTarget("active", "resume")).toBeNull();
    expect(growthMoveTarget("ended", "end")).toBeNull();
    expect(growthMoveTarget("paused", "end")).toBe("ended");
  });

  it("reads what Davi types: whole numbers, dollars, real dates and past months", () => {
    expect(parseCount("1,200")).toBe(1200);
    expect(parseCount("")).toBeNull();
    expect(parseCount("2.5")).toBe("bad");
    expect(parseCount("-3")).toBe("bad");
    expect(parseMoneyCents("$1,450.50")).toBe(145050);
    expect(parseMoneyCents("0")).toBe(0);
    expect(parseMoneyCents("12.345")).toBe("bad");
    expect(parseMoneyCents("30000000")).toBe("bad");
    expect(startDateOk("2026-02-30", "2026-10-16")).toBe(false);
    expect(startDateOk("2026-10-01", "2026-10-16")).toBe(true);
    expect(startDateOk("2028-01-01", "2026-10-16")).toBe(false);
    expect(checkInMonthOk("2026-10", "2026-10-16")).toBe(true);
    expect(checkInMonthOk("2026-11", "2026-10-16")).toBe(false);
    expect(checkInMonthOk("2026-13", "2026-10-16")).toBe(false);
    expect(recentMonths("2026-02", 3)).toEqual(["2026-02", "2026-01", "2025-12"]);
    const f = parseCheckIn(
      (k) => ({ newLeads: "12", moneyWon: "4,000", note: " Good  month " })[k],
    );
    expect(f).toEqual({
      ok: true,
      numbers: {
        newLeads: 12,
        calls: null,
        jobsWon: null,
        moneyWonCents: 400000,
        reviewsGained: null,
        adSpendCents: null,
      },
      note: "Good month",
    });
    expect(parseCheckIn((k) => (k === "calls" ? "lots" : undefined))).toEqual({
      ok: false,
      field: "calls",
    });
  });

  it("an update has a one-line title (≤80) and text (≤2000)", () => {
    expect(parseUpdate("  New  ads\nlive ", "Line one\r\n\r\n\r\nLine two")).toEqual({
      ok: true,
      title: "New ads live",
      body: "Line one\n\nLine two",
    });
    expect(parseUpdate("", "x").ok).toBe(false);
    expect(parseUpdate("x".repeat(81), "x").ok).toBe(false);
    expect(parseUpdate("x", "x".repeat(2001)).ok).toBe(false);
  });

  it("a start date begins at local midnight in the client's zone, across DST", () => {
    expect(localDayStart("2026-10-01", "America/New_York").toISOString()).toBe(
      "2026-10-01T04:00:00.000Z",
    );
    expect(localDayStart("2026-12-01", "America/New_York").toISOString()).toBe(
      "2026-12-01T05:00:00.000Z",
    );
    expect(localDayStart("2026-10-01", "America/Los_Angeles").toISOString()).toBe(
      "2026-10-01T07:00:00.000Z",
    );
    // 11pm Pacific on Oct 31 is still October there.
    expect(monthKeyOf(new Date("2026-11-01T06:00:00Z"), "America/Los_Angeles")).toBe("2026-10");
    expect(monthKeyOf(new Date("2026-11-01T06:00:00Z"), "America/New_York")).toBe("2026-11");
  });

  it("numbers come only from Davi's check-ins, with the source on every one; nothing invented", () => {
    expect(periodMetrics("since", null)).toEqual([]);
    const totals = sumCheckIns([
      row("2026-09", { newLeads: 4, moneyWonCents: 120000 }),
      row("2026-10", { newLeads: 6, adSpendCents: 50000 }),
    ]);
    const since = periodMetrics("since", totals);
    expect(since.map((m) => m.key)).toEqual(["money", "newLeads", "adSpend"]);
    expect(since[0]).toEqual({
      key: "money",
      label: "Money from jobs you won since Growth started (as you told Davi)",
      value: "$1,200",
      source: "From your monthly check-ins with Davi (1 month).",
    });
    expect(since[1]!.value).toBe("10");
    expect(since[1]!.source).toBe("From your monthly check-ins with Davi (2 months).");
    const month = periodMetrics("month", sumCheckIns([row("2026-10", { calls: 3 })]));
    expect(month).toEqual([
      {
        key: "calls",
        label: "Calls",
        value: "3",
        source: "From your monthly check-in with Davi.",
      },
    ]);
    for (const m of [...since, ...month])
      expect(`${m.label} ${m.source}`).not.toMatch(/we made|made you|inbox|guarantee/i);
  });
});

describe("Invite to Growth and the first sign-in", () => {
  it("lets them sign in, makes them a client once, and starts no trial", async () => {
    expect(
      await inviteToGrowth(
        { email: "Pat@Shop.com", services: ["reviews", "website"], startedOn: "2026-10-05" },
        NOW,
      ),
    ).toBe("invited");
    expect(await isAllowedToSignIn("pat@shop.com")).toBe(true);
    // Tapping it again only changes the services and date.
    expect(
      await inviteToGrowth(
        { email: "pat@shop.com", services: ["website"], startedOn: "2026-10-06" },
        NOW,
      ),
    ).toBe("updated");

    const { workspace } = await ensureUserAndWorkspace({ email: "pat@shop.com" });
    expect(workspace.status).toBe("invited");
    expect(workspace.evaluationStartedAt).toBeNull();
    const c = await portalClient(workspace.id);
    expect(c).toMatchObject({ status: "active", startedOn: "2026-10-06", services: ["website"] });
    const [inv] = await database.select().from(invites).where(eq(invites.email, "pat@shop.com"));
    expect(inv!.growthInvitedAt).toBeNull();
    expect(inv!.acceptedAt).not.toBeNull();

    // A second sign-in changes nothing.
    await ensureUserAndWorkspace({ email: "pat@shop.com" });
    expect(await database.select().from(growthClients)).toHaveLength(1);
    // Someone with an account is refused (Start Growth for this account is the way).
    expect(
      await inviteToGrowth({
        email: "pat@shop.com",
        services: ["website"],
        startedOn: "2026-10-06",
      }),
    ).toBe("has_account");
  });

  it("an ordinary app invite never makes a Growth client", async () => {
    await database.insert(invites).values({ email: "app@shop.com" });
    const { workspace } = await ensureUserAndWorkspace({ email: "app@shop.com" });
    expect(await portalClient(workspace.id)).toBeNull();
  });

  it("the invite email goes once per invite, content-free apart from the sign-in link", async () => {
    await inviteToGrowth({ email: "sam@shop.com", services: ["reviews"], startedOn: "2026-10-05" });
    expect(await sendGrowthInviteEmail("sam@shop.com")).toBe("sent");
    expect(await sendGrowthInviteEmail("sam@shop.com")).toBe("already_sent");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const e = sendEmail.mock.calls[0]![0];
    expect(e.subject).toBe("Your Squared Away Growth dashboard");
    expect(e.text).toContain("/signin");
    expect(e.idempotencyKey).not.toContain("sam");
  });
});

describe("admin actions", () => {
  it("refuse anyone but Davi (404) before touching anything", async () => {
    const o = await owner("owner@shop.com");
    const c = await client(o.workspaceId);
    as(o);
    for (const run of [
      () => actions.startGrowthAction(form({ workspaceId: o.workspaceId })),
      () => actions.moveGrowthAction(form({ clientId: c.id, move: "end" })),
      () => actions.postGrowthUpdateAction(form({ clientId: c.id, title: "t", body: "b" })),
      () =>
        actions.saveGrowthMonthAction(form({ clientId: c.id, month: "2026-10", newLeads: "1" })),
      () => actions.removeGrowthRequestAction(form({ email: "x@y.com" })),
      () =>
        actions.inviteToGrowthAction(
          form({ email: "x@y.com", services: "reviews", startedOn: "2026-10-01" }),
        ),
    ])
      await expect(run()).rejects.toBeInstanceOf(NotFound);
    expect((await database.select().from(growthClients))[0]!.status).toBe("active");
    expect(await database.select().from(growthUpdates)).toEqual([]);
    expect(await database.select().from(growthMonthly)).toEqual([]);
    expect(await database.select().from(invites)).toEqual([]);
  });

  it("Davi starts, changes, pauses, resumes and ends; input is checked on the server", async () => {
    const davi = await owner(ADMIN);
    const o = await owner("owner@shop.com");
    as(davi);
    expect(
      await redirectOf(
        actions.startGrowthAction(
          form({
            workspaceId: o.workspaceId,
            startedOn: "2026-10-01",
            timeZone: "America/New_York",
          }),
        ),
      ),
    ).toBe("/admin/growth?error=growth_input");
    expect(
      await redirectOf(
        actions.startGrowthAction(
          form({
            workspaceId: o.workspaceId,
            services: ["reviews", "nonsense"],
            startedOn: "2026-10-01",
            timeZone: "Europe/Paris",
          }),
        ),
      ),
    ).toBe("/admin/growth?error=growth_input");
    const start = form({
      workspaceId: o.workspaceId,
      services: ["reviews", "nonsense"],
      startedOn: "2026-10-01",
      timeZone: "America/Chicago",
    });
    expect(await redirectOf(actions.startGrowthAction(start))).toBe(
      "/admin/growth?done=growth_started",
    );
    expect(await redirectOf(actions.startGrowthAction(start))).toBe(
      "/admin/growth?error=growth_already",
    );
    const c = (await portalClient(o.workspaceId))!;
    expect(c).toMatchObject({ services: ["reviews"], timeZone: "America/Chicago" });
    expect(
      await redirectOf(actions.moveGrowthAction(form({ clientId: c.id, move: "resume" }))),
    ).toBe("/admin/growth?error=growth_status");
    expect(
      await redirectOf(actions.moveGrowthAction(form({ clientId: c.id, move: "pause" }))),
    ).toBe("/admin/growth?done=growth_pause");
    expect(await portalClient(o.workspaceId)).not.toBeNull();
    expect(await moveGrowthClient(c.id, "end", NOW)).toBe("ok");
    expect(await portalClient(o.workspaceId)).toBeNull();
    expect(await postGrowthUpdate(c.id, { title: "t", body: "b" })).toEqual({ status: "ended" });
    // Ended: Start Growth opens it again.
    expect(
      await startGrowth({
        workspaceId: o.workspaceId,
        services: ["website"],
        startedOn: "2026-10-10",
        timeZone: "America/New_York",
      }),
    ).toBe("restarted");
    expect(await portalClient(o.workspaceId)).toMatchObject({ status: "active", endedAt: null });
  });

  it("an update is emailed once (title and link only); without email set up nothing is marked", async () => {
    const o = await owner("owner@shop.com");
    const c = await client(o.workspaceId);
    const posted = await postGrowthUpdate(c.id, { title: "Ads are live", body: "Details here." });
    if (posted.status !== "posted") throw new Error("not posted");

    sendEmail.mockResolvedValueOnce("not_configured");
    expect(await notifyGrowthUpdate(posted.updateId)).toBe("not_configured");
    expect((await database.select().from(growthUpdates))[0]!.notifiedAt).toBeNull();

    expect(await notifyGrowthUpdate(posted.updateId)).toBe("sent");
    expect(await notifyGrowthUpdate(posted.updateId)).toBe("skipped");
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const e = sendEmail.mock.calls[1]![0];
    expect(e.to).toBe("owner@shop.com");
    expect(e.subject).toBe("New update from Squared Away Growth");
    expect(e.text).toContain("Ads are live");
    expect(e.text).toContain("/my-growth");
    expect(e.text).not.toContain("Details here.");
    expect(e.idempotencyKey).toBe(`growth-update-${o.workspaceId}-${posted.updateId}`);
    expect((await database.select().from(growthUpdates))[0]!.notifiedAt).not.toBeNull();

    // A failed send is logged by name only and leaves it unmarked for "Email it to them".
    const p2 = await postGrowthUpdate(c.id, { title: "Second", body: "x" });
    if (p2.status !== "posted") throw new Error("not posted");
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    sendEmail.mockRejectedValueOnce(new Error("Resend 500 owner@shop.com"));
    expect(await notifyGrowthUpdate(p2.updateId)).toBe("failed");
    expect(JSON.stringify(log.mock.calls)).not.toContain("owner@shop.com");
    log.mockRestore();
  });

  it("the post action emails at once and says so", async () => {
    const davi = await owner(ADMIN);
    const o = await owner("owner@shop.com");
    const c = await client(o.workspaceId);
    as(davi);
    expect(
      await redirectOf(
        actions.postGrowthUpdateAction(form({ clientId: c.id, title: "", body: "x" })),
      ),
    ).toBe("/admin/growth?error=growth_update_input");
    expect(
      await redirectOf(
        actions.postGrowthUpdateAction(form({ clientId: c.id, title: "Hi", body: "Text" })),
      ),
    ).toBe("/admin/growth?done=growth_posted_emailed");
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it("monthly numbers: saved per month, emptied months removed, future months refused", async () => {
    const davi = await owner(ADMIN);
    const o = await owner("owner@shop.com");
    const c = await client(o.workspaceId);
    as(davi);
    const save = (f: Record<string, string>) =>
      redirectOf(actions.saveGrowthMonthAction(form({ clientId: c.id, ...f })));
    expect(await save({ month: "2099-01", newLeads: "1" })).toBe(
      "/admin/growth?error=growth_month_input",
    );
    expect(await save({ month: "2026-09", newLeads: "x" })).toBe(
      "/admin/growth?error=growth_month_input",
    );
    expect(await save({ month: "2026-09", newLeads: "4", moneyWon: "1,200" })).toBe(
      "/admin/growth?done=growth_month_saved",
    );
    expect(await save({ month: "2026-09", newLeads: "5" })).toBe(
      "/admin/growth?done=growth_month_saved",
    );
    const [m] = await database.select().from(growthMonthly);
    expect(m).toMatchObject({ month: "2026-09", newLeads: 5, moneyWonCents: null });
    expect(await saveGrowthMonth(c.id, "2026-09", { ...m!, newLeads: null }, null)).toBe("cleared");
    expect(await database.select().from(growthMonthly)).toEqual([]);
  });
});

describe("Remove a Growth request", () => {
  const block = formatGrowthBlock({
    at: "2026-10-12 09:12",
    services: ["Reviews"],
    phone: "617-555-0142",
  });

  it("a Growth-only entry is deleted; an app sign-up keeps everything but the Growth block", async () => {
    await database.insert(waitlist).values([
      {
        email: "only@x.com",
        name: "Sam",
        teamSize: "growth-only",
        phone: "617-555-0142",
        note: block,
      },
      { email: "mixed@x.com", name: "Rosa", teamSize: "2–5", note: `Two vans\n\n${block}` },
      { email: "app@x.com", name: "Al", teamSize: "Just me", note: "Hi" },
    ]);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(await removeGrowthRequest("ONLY@x.com")).toBe("deleted");
    expect(await removeGrowthRequest("mixed@x.com")).toBe("block_removed");
    expect(await removeGrowthRequest("app@x.com")).toBe("no_request");
    expect(await removeGrowthRequest("nobody@x.com")).toBe("not_found");
    expect(JSON.stringify(info.mock.calls)).not.toMatch(/@x\.com|Sam|Rosa|617/);
    info.mockRestore();
    const rows = await database.select().from(waitlist);
    expect(rows.map((r) => r.email).sort()).toEqual(["app@x.com", "mixed@x.com"]);
    const mixed = rows.find((r) => r.email === "mixed@x.com")!;
    expect(mixed.note).toBe("Two vans");
    expect(splitWaitlistNote(mixed.note).growth).toEqual([]);
    expect(withoutGrowthBlocks(block)).toBeNull();
  });

  it("only Davi may, and the action answers in the waitlist section", async () => {
    await database
      .insert(waitlist)
      .values({ email: "only@x.com", name: "Sam", teamSize: "growth-only", note: block });
    as(await owner("owner@shop.com"));
    await expect(
      actions.removeGrowthRequestAction(form({ email: "only@x.com" })),
    ).rejects.toBeInstanceOf(NotFound);
    expect(await database.select().from(waitlist)).toHaveLength(1);
    as(await owner(ADMIN));
    expect(await redirectOf(actions.removeGrowthRequestAction(form({ email: "only@x.com" })))).toBe(
      "/admin?done=wl_growth_request_deleted#waitlist",
    );
    expect(await database.select().from(waitlist)).toEqual([]);
  });
});

describe("the sign-in choice and the dashboard", () => {
  it("/start: Growth clients choose; everyone else goes on to /queue", async () => {
    const plain = await owner("plain@shop.com");
    as(plain);
    expect(await redirectOf(StartPage())).toBe("/queue");
    const ended = await owner("ended@shop.com");
    await client(ended.workspaceId, { status: "ended" });
    as(ended);
    expect(await redirectOf(StartPage())).toBe("/queue");
    const paused = await owner("paused@shop.com");
    await client(paused.workspaceId, { status: "paused" });
    as(paused);
    const page = textOf(await StartPage());
    expect(page).toContain(portalCopy.start.inbox);
    expect(page).toContain('"/my-growth"');
    expect(page).toContain('"/queue"');
    // Not signed in: sign-in first.
    session.email = null;
    expect(await redirectOf(StartPage())).toBe("/signin");
  });

  it("/my-growth is a 404 for anyone who isn't an active or paused client", async () => {
    const plain = await owner("plain@shop.com");
    as(plain);
    await expect(MyGrowthPage()).rejects.toBeInstanceOf(NotFound);
    const ended = await owner("ended@shop.com");
    await client(ended.workspaceId, { status: "ended" });
    as(ended);
    await expect(MyGrowthPage()).rejects.toBeInstanceOf(NotFound);
  });

  it("shows only this client's rows, months in the client's zone, from the start month on", async () => {
    const a = await owner("a@shop.com");
    const b = await owner("b@shop.com");
    const ca = await client(a.workspaceId, {
      startedOn: "2026-09-10",
      timeZone: "America/Los_Angeles",
    });
    const cb = await client(b.workspaceId);
    await database.insert(growthMonthly).values([
      { growthClientId: ca.id, month: "2026-08", newLeads: 100 },
      { growthClientId: ca.id, month: "2026-09", newLeads: 4, moneyWonCents: 300000 },
      { growthClientId: ca.id, month: "2026-10", newLeads: 6 },
      { growthClientId: cb.id, month: "2026-10", newLeads: 999, moneyWonCents: 99900000 },
    ]);
    await postGrowthUpdate(cb.id, { title: "For B only", body: "x" });
    await postGrowthUpdate(ca.id, { title: "For A", body: "y" }, new Date("2026-10-01T00:00:00Z"));

    // 11pm on Oct 31 in Los Angeles: still October for this client.
    const d = await growthDashboard(ca, new Date("2026-11-01T06:00:00Z"));
    expect(d.monthName).toBe("October");
    expect(d.since.metrics.find((m) => m.key === "newLeads")!.value).toBe("10");
    expect(d.since.metrics.find((m) => m.key === "money")!.value).toBe("$3,000");
    expect(d.thisMonth.metrics.map((m) => [m.key, m.value])).toEqual([["newLeads", "6"]]);
    expect(d.updates.map((u) => u.title)).toEqual(["For A"]);
    expect(JSON.stringify(d)).not.toContain("999");

    // A day later it's November there: this month is empty.
    const nov = await growthDashboard(ca, new Date("2026-11-02T08:00:00Z"));
    expect(nov.thisMonth).toEqual({ checkIns: 0, metrics: [] });

    // A start date ahead: nothing counted yet.
    const later = await growthDashboard({ ...ca, startedOn: "2026-12-01" }, NOW);
    expect(later.started).toBe(false);
    expect(later.since.metrics).toEqual([]);
  });

  it("the page renders the empty state before the first check-in", async () => {
    const o = await owner("o@shop.com");
    await client(o.workspaceId, { startedOn: "2026-10-01" });
    as(o);
    const page = textOf(await MyGrowthPage());
    expect(page).toContain("Davi adds these after your first monthly check-in.");
    expect(page).toContain(growthCopy.pledge.percent);
  });

  it("admin lists what Davi entered and who's invited or a client", async () => {
    const o = await owner("o@shop.com");
    await client(o.workspaceId);
    await inviteToGrowth({ email: "new@shop.com", services: ["reviews"], startedOn: "2026-10-01" });
    const data = await listGrowthAdmin();
    expect(data.clients.map((c) => c.ownerEmail)).toEqual(["o@shop.com"]);
    expect(data.pending.map((p) => p.email)).toEqual(["new@shop.com"]);
    const states = await growthStateForEmails(["O@shop.com", "new@shop.com", "none@shop.com"]);
    expect(states.get("o@shop.com")).toEqual({ invitedAt: null, client: "active" });
    expect(states.get("new@shop.com")?.invitedAt).toBeInstanceOf(Date);
    expect(states.has("none@shop.com")).toBe(false);
  });
});

describe("Delete my account", () => {
  it("takes the Growth client, its updates and its months with it", async () => {
    const o = await owner("o@shop.com");
    const c = await client(o.workspaceId);
    await postGrowthUpdate(c.id, { title: "t", body: "b" });
    await saveGrowthMonth(
      c.id,
      "2026-10",
      {
        newLeads: 1,
        calls: null,
        jobsWon: null,
        moneyWonCents: null,
        reviewsGained: null,
        adSpendCents: null,
      },
      null,
    );
    const other = await owner("other@shop.com");
    await client(other.workspaceId);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await deleteAccount(o.userId, { revoke: async () => {} } as unknown as MailboxConnector);
    info.mockRestore();
    expect((await database.select().from(growthClients)).map((x) => x.workspaceId)).toEqual([
      other.workspaceId,
    ]);
    expect(await database.select().from(growthUpdates)).toEqual([]);
    expect(await database.select().from(growthMonthly)).toEqual([]);
  });
});

/** Every file this package added, read as text for the boundary and copy checks. */
const GROWTH_FILES = [
  "src/server/growth-client-rules.ts",
  "src/server/growth-clients.ts",
  "src/app/start/page.tsx",
  "src/app/my-growth/page.tsx",
  "src/app/(app)/admin/growth-actions.ts",
  "src/app/(app)/admin/growth-admin.tsx",
  "src/components/growth-portal/portal-copy.ts",
  "src/components/app/growth-mention.tsx",
];

describe("Growth never uses inbox data", () => {
  const BANNED_MODULES = [
    /^@\/mailbox/,
    /^@\/ai/,
    /^@\/jobs/,
    /^@\/server\/sync/,
    /classification/,
    /\binbox\b/,
    /drafts/,
    /voice/,
    /quote/,
    /customers/,
    /followups/,
    /digest/,
    /lead-pay/,
    /\/activity$/,
    /\/mailboxes$/,
    /\/snooze$/,
  ];
  const BANNED_TABLES = [
    "threads",
    "messages",
    "drafts",
    "mailboxes",
    "voiceProfiles",
    "businessProfiles",
    "usage",
    "activityLog",
  ];

  it("no Growth file imports the inbox app's modules or tables", () => {
    for (const f of GROWTH_FILES) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/from\s+"([^"]+)"/g))
        for (const bad of BANNED_MODULES) expect(m[1], `${f} imports ${m[1]}`).not.toMatch(bad);
      const schema = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"@\/db\/schema"/.exec(src);
      const names = (schema?.[1] ?? "").split(",").map((s) => s.trim().replace(/^type\s+/, ""));
      for (const t of BANNED_TABLES) expect(names, `${f} imports ${t}`).not.toContain(t);
    }
  });

  it("the in-app mention takes no props and shows the same words to everyone", () => {
    const src = readFileSync("src/components/app/growth-mention.tsx", "utf8");
    expect(src).toMatch(/export function GrowthMention\(\)/);
    expect(growthCopy.inApp.line).toBe(
      "Want more work coming in? Squared Away Growth is a separate service. Nothing from your email is used for it.",
    );
    // Only the More screen shows it.
    const users = readdirSyncDeep("src").filter(
      (f) => /\.(tsx?|jsx?)$/.test(f) && readFileSync(f, "utf8").includes("<GrowthMention"),
    );
    expect(users).toEqual(["src/app/(app)/more/page.tsx"]);
  });

  it("portal copy: no pronouns for Davi, no 'builder', no claims of results", () => {
    const strings = JSON.stringify(portalCopy, (_k, v) =>
      typeof v === "function" ? v("Oct 1, 2026") : v,
    );
    const text = `${strings}\n${GROWTH_FILES.map((f) => readFileSync(f, "utf8")).join("\n")}`;
    expect(text).not.toMatch(/\b(he|him|his|himself|builder)\b/i);
    expect(text).not.toMatch(/\bGC\b/);
    expect(text.toLowerCase()).not.toMatch(/we made you|made you \$|guarantee|we earned/);
  });
});

/** Every string in a rendered element tree's props (text and hrefs), quoted like JSON. */
function textOf(node: unknown, seen = new Set<unknown>()): string {
  if (typeof node === "string") return JSON.stringify(node);
  if (typeof node === "number") return String(node);
  if (!node || typeof node !== "object" || seen.has(node)) return "";
  seen.add(node);
  if (Array.isArray(node)) return node.map((n) => textOf(n, seen)).join(" ");
  const props = (node as { props?: Record<string, unknown> }).props;
  return props
    ? Object.values(props)
        .map((v) => textOf(v, seen))
        .join(" ")
    : "";
}

function readdirSyncDeep(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? readdirSyncDeep(p) : [p];
  });
}
