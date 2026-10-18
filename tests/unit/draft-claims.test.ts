import { randomBytes } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setModelTransportForTests } from "@/ai/client";
import type { Database } from "@/db";
import { appSettings, drafts, messages, threads, usage } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { claimDrafting, DRAFT_CLAIM_MS, releaseDrafting } from "@/server/draft-claims";
import { createDraftForThread } from "@/server/drafts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { createTestDb } from "../support/db";
import { fakeTransport } from "../support/fake-model";
import { FakeWriter } from "../support/fake-writer";

vi.mock("react-dom", async (orig) => ({
  ...(await orig<typeof import("react-dom")>()),
  useFormStatus: () => ({ pending: pendingNow }),
}));
let pendingNow = false;

/** Check 9 P9: a double tap on Draft a reply writes one draft with one model call. */
const NOW = new Date("2026-09-28T12:00:00Z");
let database: Database;
let workspaceId: string;
let mailboxId: string;
let writer: FakeWriter;
const deps = () => ({ writerFor: () => writer, now: () => NOW });

async function seedThread() {
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId,
      gmailThreadId: "gt1",
      inInbox: true,
      subject: "Leak",
      category: "complaint",
      needsOwner: true,
      summary: "Leak is back.",
      classifiedAt: NOW,
      lastMessageAt: new Date(NOW.getTime() - 3600_000),
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId,
    gmailMessageId: "gt1-m1",
    rfc822MessageId: "<gt1-m1@mail.x.com>",
    direction: "in",
    fromAddress: "dana@x.com",
    fromName: "Dana Ruiz",
    subject: "Leak",
    bodyText: "The leak came back under the sink.",
    sentAt: new Date(NOW.getTime() - 2 * 3600_000),
  });
  return t!;
}

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AI_DAILY_CALL_CAP = "100";
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
  writer = new FakeWriter();
});

const modelDraft = {
  body: "Hi Dana,\n\nSorry it's back. Can you send a photo of the leak?\n\nDavi",
  reason: "Complaint, leak back.",
  flags: [],
  confidence: 0.8,
  used_facts: [],
};

describe("Check 9 P9: one drafting run per thread", () => {
  it("two taps at once: one model call, one Gmail draft, one draft row", async () => {
    const { transport, calls } = fakeTransport([modelDraft, modelDraft]);
    setModelTransportForTests(transport);
    const t = await seedThread();
    const tap = () => createDraftForThread(t.id, { trigger: "owner", workspaceId, ...deps() });
    const results = await Promise.all([tap(), tap()]);
    expect(results.map((r) => r.status).sort()).toEqual(["created", "skipped"]);
    expect(results.find((r) => r.status === "skipped")).toEqual({
      status: "skipped",
      reason: "already_pending",
    });
    expect(calls).toHaveLength(1);
    expect(writer.drafts.size).toBe(1);
    expect(writer.calls.filter((c) => c.startsWith("delete"))).toHaveLength(0);
    expect(await database.select().from(drafts)).toHaveLength(1);
    const [u] = await database.select().from(usage);
    expect(u!.draftsCreated).toBe(1);
    // The lease is handed back once the run is done.
    expect(await database.select().from(appSettings)).toEqual([]);
  });

  it("the lease is per thread, ends on release, and lapses after two minutes", async () => {
    const a = await claimDrafting("t-a", NOW);
    expect(a).toBeTruthy();
    expect(await claimDrafting("t-a", NOW)).toBeNull();
    expect(await claimDrafting("t-b", NOW)).toBeTruthy();
    // Someone else's token can't release it.
    await releaseDrafting("t-a", "not-mine");
    expect(await claimDrafting("t-a", NOW)).toBeNull();
    await releaseDrafting("t-a", a!);
    const again = await claimDrafting("t-a", NOW);
    expect(again).toBeTruthy();
    // A run that died: its lease lapses.
    expect(await claimDrafting("t-a", new Date(NOW.getTime() + DRAFT_CLAIM_MS - 1000))).toBeNull();
    expect(
      await claimDrafting("t-a", new Date(NOW.getTime() + DRAFT_CLAIM_MS + 1000)),
    ).toBeTruthy();
    const rows = await database.select().from(appSettings);
    expect(JSON.stringify(rows)).not.toMatch(/dana|leak/i);
  });

  it("the button says it's writing, is disabled, and says nothing is sent", async () => {
    vi.doMock("@/app/(app)/queue/actions", () => ({}));
    const { DraftReplyButton, DRAFTING_BUSY, DRAFTING_NOTE } =
      await import("@/app/(app)/queue/draft-reply-button");
    pendingNow = false;
    const idle = renderToStaticMarkup(createElement(DraftReplyButton));
    expect(idle).toContain("Draft a reply");
    expect(idle).not.toContain('disabled=""');
    expect(idle).not.toContain(DRAFTING_NOTE);
    pendingNow = true;
    const busy = renderToStaticMarkup(createElement(DraftReplyButton));
    expect(DRAFTING_BUSY).toBe("Writing a draft…");
    expect(busy).toContain(DRAFTING_BUSY);
    expect(busy).toContain('disabled=""');
    expect(busy).toContain("This takes a few seconds. Nothing is sent.");
  });
});
