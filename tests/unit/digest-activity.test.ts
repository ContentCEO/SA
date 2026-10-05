import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { activityLog, businessProfiles, drafts, messages, threads, workspaces } from "@/db/schema";
import type { OutgoingEmail } from "@/lib/email";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { describeActivity, listActivity, monthSummary } from "@/server/activity";
import { buildDigest, digestDue, localParts, sendDigests } from "@/server/digest";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { digestSettingsInput, saveDigestSettings } from "@/server/profile";
import { createTestDb } from "../support/db";

// 11:30 UTC = 7:30am in New York (EDT), 4:30am in Los Angeles.
const NOW = new Date("2026-10-06T11:30:00Z");

describe("digest timing", () => {
  it("works in the owner's time zone", () => {
    expect(localParts(NOW, "America/New_York")).toEqual({ date: "2026-10-06", hour: 7 });
    expect(localParts(NOW, "America/Los_Angeles")).toEqual({ date: "2026-10-06", hour: 4 });
    expect(localParts(NOW, "Not/AZone")).toEqual({ date: "2026-10-06", hour: 7 });
  });

  it("is due once a day, at or after the owner's hour", () => {
    const s = {
      digestEnabled: true,
      digestHour: 7,
      timeZone: "America/New_York",
      digestLastSentOn: null,
    };
    expect(digestDue(s, NOW).due).toBe(true);
    expect(digestDue({ ...s, digestHour: 8 }, NOW).due).toBe(false);
    expect(digestDue({ ...s, digestLastSentOn: "2026-10-06" }, NOW).due).toBe(false);
    expect(digestDue({ ...s, digestLastSentOn: "2026-10-05" }, NOW).due).toBe(true);
    expect(digestDue({ ...s, timeZone: "America/Los_Angeles" }, NOW).due).toBe(false);
    expect(digestDue({ ...s, digestEnabled: false }, NOW).due).toBe(false);
  });
});

describe("digest content", () => {
  const counts = {
    repliesReady: 3,
    nudgesReady: 1,
    needsYou: [{ category: "complaint" }, { category: "customer_question" }],
    sentYesterday: 2,
    sortedYesterday: 14,
  };

  it("says what's waiting in counts and categories", () => {
    const d = buildDigest(counts, "https://app/queue", "https://app/settings");
    expect(d.subject).toBe("6 things waiting on you");
    expect(d.text).toContain("2 emails need you: a complaint, a question.");
    expect(d.text).toContain("3 replies drafted and waiting for your okay.");
    expect(d.text).toContain("1 follow-up ready");
    expect(d.text).toContain("Yesterday: 14 emails sorted, 2 replies sent.");
    expect(d.html).toContain('href="https://app/queue"');
    expect(d.text).toContain("Nothing is sent without your okay.");
    expect(d.worthSending).toBe(true);
  });

  it("a quiet day isn't worth an email", () => {
    const d = buildDigest(
      { repliesReady: 0, nudgesReady: 0, needsYou: [], sentYesterday: 0, sortedYesterday: 0 },
      "q",
      "s",
    );
    expect(d.worthSending).toBe(false);
  });
});

describe("activity wording", () => {
  it("is plain, uses only the customer's first name, and hides internal entries", () => {
    const who = { name: "Dana Ruiz", category: "quote_request" };
    expect(describeActivity("draft_created", {}, who)).toBe(
      "Drafted a reply to Dana · Quote request",
    );
    expect(describeActivity("reply_sent", { editedByOwner: true, kind: "reply" }, who)).toBe(
      "You sent a reply to Dana, after editing it",
    );
    expect(describeActivity("followup_drafted", { nudgeNumber: 2 }, who)).toBe(
      "Drafted a follow-up to Dana (the last one) · Quote request",
    );
    expect(describeActivity("workspace_status_changed", { to: "setup_paid" }, null)).toBe(
      "Setup paid — sending switched on",
    );
    expect(describeActivity("payment_received", { includesSetup: true }, null)).toMatch(
      /sending switched on/,
    );
    expect(describeActivity("subscription_changed", { to: "past_due" }, null)).toMatch(
      /didn't go through/,
    );
    expect(describeActivity("something_internal", {}, null)).toBeNull();
  });
});

describe("in the database", () => {
  let database: Database;
  let workspaceId: string;
  let mailboxId: string;
  let sent: OutgoingEmail[];
  const sender = async (e: OutgoingEmail) => {
    sent.push(e);
    return "sent" as const;
  };

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
    sent = [];
    const [t] = await database
      .insert(threads)
      .values({
        mailboxId,
        gmailThreadId: "g1",
        inInbox: true,
        subject: "SECRET-SUBJECT",
        category: "complaint",
        needsOwner: true,
        needsOwnerReason: "SECRET-REASON",
        summary: "SECRET-SUMMARY",
        classifiedAt: new Date(NOW.getTime() - 3600_000),
      })
      .returning();
    await database.insert(messages).values({
      threadId: t!.id,
      mailboxId,
      gmailMessageId: "g1-m1",
      direction: "in",
      fromName: "SECRET-NAME Person",
      fromAddress: "secret@customer.com",
      bodyText: "SECRET-BODY",
      sentAt: new Date(NOW.getTime() - 7200_000),
    });
    await database.insert(activityLog).values({
      workspaceId,
      actor: "owner",
      action: "marked_needs_owner",
      threadId: t!.id,
    });
  });

  it("sends the owner one digest a day — counts only, retry-safe", async () => {
    expect(await sendDigests(NOW, { send: sender })).toMatchObject({ sent: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("owner@shop.com");
    expect(sent[0]!.idempotencyKey).toBe(`digest-${workspaceId}-2026-10-06`);
    expect(sent[0]!.text).toContain("1 email needs you: a complaint.");
    expect(`${sent[0]!.subject}${sent[0]!.text}${sent[0]!.html}`).not.toMatch(/SECRET|secret@/);

    // Later the same morning: nothing more.
    expect(await sendDigests(new Date(NOW.getTime() + 3600_000), { send: sender })).toMatchObject({
      sent: 0,
    });
    expect(sent).toHaveLength(1);
  });

  it("waits for the owner's hour and respects off", async () => {
    await saveDigestSettings(
      workspaceId,
      digestSettingsInput.parse({ enabled: "on", hour: "9", timeZone: "America/New_York" }),
    );
    await sendDigests(NOW, { send: sender });
    expect(sent).toHaveLength(0);
    await saveDigestSettings(
      workspaceId,
      digestSettingsInput.parse({ hour: "7", timeZone: "America/New_York" }),
    );
    await sendDigests(NOW, { send: sender });
    expect(sent).toHaveLength(0);
  });

  it("an unknown time zone falls back to Eastern instead of failing", () => {
    expect(digestSettingsInput.parse({ hour: "7", timeZone: "Mars/Base" }).timeZone).toBe(
      "America/New_York",
    );
    expect(digestSettingsInput.safeParse({ hour: "3", timeZone: "UTC" }).success).toBe(false);
  });

  it("read-only accounts get no digest", async () => {
    await database
      .update(workspaces)
      .set({ status: "evaluation_expired" })
      .where(eq(workspaces.id, workspaceId));
    await sendDigests(NOW, { send: sender });
    expect(sent).toHaveLength(0);
  });

  it("without email set up, nothing is sent and the day isn't marked done", async () => {
    const run = await sendDigests(NOW, { send: async () => "not_configured" });
    expect(run.notConfigured).toBe(true);
    const [p] = await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId));
    expect(p?.digestLastSentOn ?? null).toBeNull();
  });

  it("activity shows the owner's own log in plain words", async () => {
    const entries = await listActivity(workspaceId);
    expect(entries.map((e) => e.text)).toContain(
      "You marked a conversation with SECRET-NAME as needing you",
    );
    expect(entries.map((e) => e.text)).toContain("You connected Gmail");
  });

  it("time saved is counted only from replies actually sent", async () => {
    const [t] = await database.select().from(threads);
    const base = {
      threadId: t!.id,
      mailboxId,
      toAddress: "x@y.com",
      subject: "Re",
      body: "b",
      originalBody: "b",
      reason: "r",
      promptVersion: "draft.v1",
      createdAt: NOW,
    };
    await database.insert(drafts).values([
      { ...base, gmailDraftId: "a", status: "sent", decidedAt: NOW },
      { ...base, gmailDraftId: "b", status: "edited_and_sent", decidedAt: NOW },
      { ...base, gmailDraftId: "c", status: "sent", kind: "followup", decidedAt: NOW },
      { ...base, gmailDraftId: "d", status: "discarded", decidedAt: NOW },
    ]);
    expect(await monthSummary(workspaceId, NOW)).toEqual({
      sorted: 1,
      drafted: 4,
      sent: 3,
      sentAfterEditing: 1,
      nudgesSent: 1,
      minutesSaved: 9,
    });
  });
});
