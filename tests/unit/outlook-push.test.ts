import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as notify } from "@/app/api/outlook/notify/route";
import type { Database } from "@/db";
import { mailboxes, workspaces } from "@/db/schema";
import { inngest } from "@/jobs/client";
import { createOutlookClient } from "@/mailbox/outlook/api";
import { MAX_SUBSCRIPTION_MINUTES } from "@/mailbox/outlook/subscriptions";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import {
  clientStateMatches,
  removeOutlookSubscription,
  renewOutlookSubscriptions,
  sha256Hex,
  subscriptionDue,
} from "@/server/outlook-push";
import { listSyncableMailboxes, renewWatches } from "@/server/sync";
import { createTestDb } from "../support/db";
import { createFakeGraph, type FakeGraph } from "../support/fake-graph";

/** Plan #49: Outlook push (Graph change subscriptions) and its notification route. */

const NOW = new Date("2026-10-20T06:17:00Z");
const DAY = 86_400_000;
let database: Database;
let workspaceId: string;
let mailboxId: string;
let graph: FakeGraph;
const ON = { FEATURE_OUTLOOK: "1", MS_CLIENT_ID: "ms-id", MS_CLIENT_SECRET: "ms-secret" };

const client = () =>
  createOutlookClient({
    refreshToken: graph.grantRefreshToken(),
    fetchImpl: graph.fetch,
    sleep: async () => {},
  });
/** One clock for the app and the Graph stand-in. */
let clock = NOW;
const deps = (now = NOW) => {
  clock = now;
  return { clientFor: () => client(), now: () => now, env: ON };
};
const box = async () =>
  (await database.select().from(mailboxes).where(eq(mailboxes.id, mailboxId)))[0]!;

beforeEach(async () => {
  for (const [k, v] of Object.entries(ON)) vi.stubEnv(k, v);
  vi.stubEnv("APP_URL", "https://app.example");
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  clock = NOW;
  graph = createFakeGraph({ owner: "owner@shop.com", now: () => clock });
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  await database
    .update(workspaces)
    .set({ status: "active", setupPaidVia: "stripe" })
    .where(eq(workspaces.id, workspaceId));
  mailboxId = (
    await saveConnectedMailbox(
      workspace,
      { email: "owner@shop.com", refreshToken: "rt", grantedScopes: [] },
      "outlook",
    )
  ).id;
  await database
    .update(mailboxes)
    .set({ backfillCompletedAt: NOW })
    .where(eq(mailboxes.id, mailboxId));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("subscription renewal timing", () => {
  it("is due with no subscription, no expiry, or under two days left", () => {
    expect(subscriptionDue({ pushSubscriptionId: null, watchExpiresAt: null }, NOW)).toBe(true);
    expect(subscriptionDue({ pushSubscriptionId: "s", watchExpiresAt: null }, NOW)).toBe(true);
    const at = (days: number) => new Date(NOW.getTime() + days * DAY);
    expect(subscriptionDue({ pushSubscriptionId: "s", watchExpiresAt: at(1.9) }, NOW)).toBe(true);
    expect(subscriptionDue({ pushSubscriptionId: "s", watchExpiresAt: at(2.1) }, NOW)).toBe(false);
  });

  it("creates one under Graph's 10,080-minute limit, with a random clientState kept as a hash", async () => {
    expect(await renewOutlookSubscriptions(deps())).toBe(1);
    const [sub] = [...graph.state.subscriptions.values()];
    expect(sub).toMatchObject({
      resource: "me/messages",
      changeType: "created,updated,deleted",
      notificationUrl: "https://app.example/api/outlook/notify",
    });
    const minutes = (Date.parse(sub!.expirationDateTime) - NOW.getTime()) / 60_000;
    expect(minutes).toBeLessThan(MAX_SUBSCRIPTION_MINUTES);
    expect(minutes).toBeGreaterThan(MAX_SUBSCRIPTION_MINUTES - 120);
    const row = await box();
    expect(row.pushSubscriptionId).toBe(sub!.id);
    expect(row.pushClientStateSha256).toBe(sha256Hex(sub!.clientState));
    expect(row.pushClientStateSha256).not.toContain(sub!.clientState);
    expect(row.watchExpiresAt!.toISOString()).toBe(sub!.expirationDateTime);
  });

  it("the daily job renews in place with under two days left, and not before", async () => {
    await renewOutlookSubscriptions(deps());
    const id = (await box()).pushSubscriptionId;
    // Next day: 5.9 days left, nothing to do.
    expect(await renewOutlookSubscriptions(deps(new Date(NOW.getTime() + DAY)))).toBe(0);
    // Day 5: 1.9 days left → renewed (PATCH), same id, a fresh week.
    const day5 = new Date(NOW.getTime() + 5 * DAY);
    graph.state.calls.length = 0;
    expect(await renewOutlookSubscriptions(deps(day5))).toBe(1);
    expect(graph.state.calls.filter((c) => c.path.startsWith("/subscriptions"))).toEqual([
      expect.objectContaining({ method: "PATCH", path: `/subscriptions/${id}` }),
    ]);
    const row = await box();
    expect(row.pushSubscriptionId).toBe(id);
    expect(row.watchExpiresAt!.getTime()).toBeGreaterThan(day5.getTime() + 6 * DAY);
  });

  it("a subscription Graph lost (404 on renew) is made again", async () => {
    await renewOutlookSubscriptions(deps());
    const old = (await box()).pushSubscriptionId!;
    graph.state.subscriptions.clear();
    expect(await renewOutlookSubscriptions(deps(new Date(NOW.getTime() + 6 * DAY)))).toBe(1);
    expect((await box()).pushSubscriptionId).not.toBe(old);
  });

  it("skips read-only accounts, paused or lost mailboxes, unfinished first reads, and Gmail", async () => {
    await database
      .update(workspaces)
      .set({ status: "canceled" })
      .where(eq(workspaces.id, workspaceId));
    expect(await renewOutlookSubscriptions(deps())).toBe(0);
    await database
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, workspaceId));
    await database
      .update(mailboxes)
      .set({ status: "reconnect_needed" })
      .where(eq(mailboxes.id, mailboxId));
    expect(await renewOutlookSubscriptions(deps())).toBe(0);
    await database
      .update(mailboxes)
      .set({ status: "active", backfillCompletedAt: null })
      .where(eq(mailboxes.id, mailboxId));
    expect(await renewOutlookSubscriptions(deps())).toBe(0);
    expect(graph.state.calls).toEqual([]);
  });

  it("GUARDRAIL: with the switch off, nothing runs and no Microsoft host is contacted", async () => {
    const f = vi.fn(graph.fetch);
    vi.stubGlobal("fetch", f);
    for (const env of [{}, { FEATURE_OUTLOOK: "1" }, { MS_CLIENT_ID: "a", MS_CLIENT_SECRET: "b" }])
      expect(await renewOutlookSubscriptions({ env, now: () => NOW })).toBe(0);
    await removeOutlookSubscription({ ...(await box()), pushSubscriptionId: "sub-x" }, { env: {} });
    expect(f).not.toHaveBeenCalled();
    expect(graph.state.calls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("Gmail's watch renewal never touches an Outlook mailbox", async () => {
    vi.stubEnv("GMAIL_PUBSUB_TOPIC", "projects/x/topics/y");
    const watch = vi.fn();
    expect(await renewWatches({ readerFor: () => ({ watch }) as never, now: () => NOW })).toBe(0);
    expect(watch).not.toHaveBeenCalled();
  });

  it("the 5-minute poll always syncs an Outlook mailbox, push or not", async () => {
    vi.stubEnv("GMAIL_PUBSUB_TOPIC", "projects/x/topics/y");
    await database
      .update(mailboxes)
      .set({ lastSyncedAt: NOW, watchExpiresAt: new Date(NOW.getTime() + 5 * DAY) })
      .where(eq(mailboxes.id, mailboxId));
    expect((await listSyncableMailboxes(NOW, { forPoll: true })).map((m) => m.id)).toEqual([
      mailboxId,
    ]);
  });

  it("removing drops the subscription at Microsoft, best effort", async () => {
    await renewOutlookSubscriptions(deps());
    await removeOutlookSubscription(await box(), deps());
    expect(graph.state.subscriptions.size).toBe(0);
    // Already gone: no throw.
    await removeOutlookSubscription(await box(), deps());
  });
});

describe("the notification route (/api/outlook/notify)", () => {
  const post = (body: unknown, qs = "") =>
    notify(
      new NextRequest(`https://app.example/api/outlook/notify${qs}`, {
        method: "POST",
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );

  async function subscribed() {
    await renewOutlookSubscriptions(deps());
    const [sub] = [...graph.state.subscriptions.values()];
    return sub!;
  }

  it("echoes Graph's validation token as plain text", async () => {
    const res = await post("", "?validationToken=Validation%3A%20Testing%20client%20application");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("Validation: Testing client application");
  });

  it("a matching clientState enqueues one sync, and handles no content", async () => {
    const sub = await subscribed();
    const sent = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
    const res = await post({
      value: [
        {
          subscriptionId: sub.id,
          clientState: sub.clientState,
          changeType: "created",
          resource: "Users/x/Messages/AAMk-1",
        },
        { subscriptionId: sub.id, clientState: sub.clientState, changeType: "updated" },
      ],
    });
    expect(res.status).toBe(202);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent.mock.calls[0]![0])).toContain(mailboxId);
    expect(JSON.stringify(sent.mock.calls[0]![0])).not.toContain("AAMk-1");
  });

  it("GUARDRAIL: a wrong or missing clientState is refused (403) and wakes nothing", async () => {
    const sub = await subscribed();
    const sent = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
    expect((await post({ value: [{ subscriptionId: sub.id, clientState: "guess" }] })).status).toBe(
      403,
    );
    expect((await post({ value: [{ subscriptionId: sub.id }] })).status).toBe(403);
    expect(sent).not.toHaveBeenCalled();
    expect(clientStateMatches(null, sub.clientState)).toBe(false);
    expect(clientStateMatches((await box()).pushClientStateSha256, sub.clientState)).toBe(true);
  });

  it("an unknown subscription is acknowledged (an orphan), garbage is a 400", async () => {
    const sent = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
    expect((await post({ value: [{ subscriptionId: "sub-gone", clientState: "x" }] })).status).toBe(
      202,
    );
    expect((await post("not json{")).status).toBe(400);
    expect(sent).not.toHaveBeenCalled();
  });

  it("a mailbox that lost access or is paused isn't synced", async () => {
    const sub = await subscribed();
    await database
      .update(mailboxes)
      .set({ status: "reconnect_needed" })
      .where(eq(mailboxes.id, mailboxId));
    const sent = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
    expect(
      (await post({ value: [{ subscriptionId: sub.id, clientState: sub.clientState }] })).status,
    ).toBe(202);
    expect(sent).not.toHaveBeenCalled();
  });

  it("GUARDRAIL: 404 for everything while the switch is off", async () => {
    const sub = await subscribed();
    vi.stubEnv("FEATURE_OUTLOOK", "");
    const sent = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
    expect((await post("", "?validationToken=abc")).status).toBe(404);
    expect(
      (await post({ value: [{ subscriptionId: sub.id, clientState: sub.clientState }] })).status,
    ).toBe(404);
    expect(sent).not.toHaveBeenCalled();
  });
});
