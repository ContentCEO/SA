import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST as push } from "@/app/api/gmail/push/route";
import type { Database } from "@/db";
import { mailboxes, workspaces } from "@/db/schema";
import { inngest } from "@/jobs/client";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { listSyncableMailboxes, renewWatches } from "@/server/sync";
import { createTestDb } from "../support/db";
import { FakeMailbox } from "../support/fake-mailbox";

const NOW = new Date("2026-10-10T14:00:00Z");
let database: Database;
let workspaceId: string;
let mailboxId: string;
let fake: FakeMailbox;
const deps = () => ({ readerFor: () => fake.reader(), now: () => NOW });

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  await database.update(workspaces).set({ status: "active" }).where(eq(workspaces.id, workspaceId));
  mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "Owner@Shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
  await database
    .update(mailboxes)
    .set({ backfillCompletedAt: NOW })
    .where(eq(mailboxes.id, mailboxId));
  fake = new FakeMailbox();
});
afterEach(() => {
  delete process.env.GMAIL_PUBSUB_TOPIC;
  delete process.env.GMAIL_PUSH_VERIFICATION_TOKEN;
  vi.restoreAllMocks();
});

describe("push watch renewal", () => {
  it("does nothing without a Pub/Sub topic (polling only)", async () => {
    expect(await renewWatches(deps())).toBe(0);
    expect(fake.calls).toBe(0);
  });

  it("starts a watch, then leaves it alone until it's within two days of expiring", async () => {
    process.env.GMAIL_PUBSUB_TOPIC = "projects/x/topics/gmail-push";
    expect(await renewWatches(deps())).toBe(1);
    const [box] = await database.select().from(mailboxes);
    expect(box!.watchExpiresAt!.getTime()).toBeGreaterThan(NOW.getTime());
    expect(await renewWatches(deps())).toBe(0);
    await database
      .update(mailboxes)
      .set({ watchExpiresAt: new Date(NOW.getTime() + 86_400_000) })
      .where(eq(mailboxes.id, mailboxId));
    expect(await renewWatches(deps())).toBe(1);
  });

  it("skips read-only accounts, and a revoked token stops the mailbox instead of failing", async () => {
    process.env.GMAIL_PUBSUB_TOPIC = "projects/x/topics/gmail-push";
    await database
      .update(workspaces)
      .set({ status: "canceled" })
      .where(eq(workspaces.id, workspaceId));
    expect(await renewWatches(deps())).toBe(0);

    await database
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, workspaceId));
    fake.revoked = true;
    expect(await renewWatches(deps())).toBe(0);
    const [box] = await database.select().from(mailboxes);
    expect(box!.status).toBe("reconnect_needed");
  });
});

describe("polling fallback", () => {
  it("polls active mailboxes of working accounts only", async () => {
    expect((await listSyncableMailboxes(NOW)).map((m) => m.id)).toEqual([mailboxId]);
    await database
      .update(workspaces)
      .set({ status: "past_due" })
      .where(eq(workspaces.id, workspaceId));
    expect(await listSyncableMailboxes(NOW)).toEqual([]);
    await database
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, workspaceId));
    await database
      .update(mailboxes)
      .set({ status: "reconnect_needed" })
      .where(eq(mailboxes.id, mailboxId));
    expect(await listSyncableMailboxes(NOW)).toEqual([]);
  });
});

describe("Gmail push endpoint", () => {
  const call = (token: string | null, data: string) =>
    push(
      new NextRequest(`https://app.example/api/gmail/push${token ? `?token=${token}` : ""}`, {
        method: "POST",
        body: JSON.stringify({ message: { data } }),
      }),
    );
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64");

  it("rejects a missing or wrong token", async () => {
    process.env.GMAIL_PUSH_VERIFICATION_TOKEN = "s3cret-token";
    expect((await call(null, b64({}))).status).toBe(403);
    expect((await call("wrong-token!", b64({}))).status).toBe(403);
  });

  it("kicks a sync for the matching active mailbox (any case), nothing for strangers", async () => {
    process.env.GMAIL_PUSH_VERIFICATION_TOKEN = "s3cret-token";
    const sent = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
    expect(
      (await call("s3cret-token", b64({ emailAddress: "owner@SHOP.com", historyId: 9 }))).status,
    ).toBe(204);
    expect(sent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent.mock.calls[0]![0])).toContain(mailboxId);

    expect(
      (await call("s3cret-token", b64({ emailAddress: "someone@else.com", historyId: 1 }))).status,
    ).toBe(204);
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("acknowledges a garbled payload instead of erroring (no endless Pub/Sub retries)", async () => {
    process.env.GMAIL_PUSH_VERIFICATION_TOKEN = "s3cret-token";
    const sent = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
    expect((await call("s3cret-token", Buffer.from("not json{").toString("base64"))).status).toBe(
      204,
    );
    expect(sent).not.toHaveBeenCalled();
  });
});
