import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import {
  activityLog,
  businessProfiles,
  drafts,
  mailboxes,
  messages,
  threads,
  voiceProfiles,
  workspaces,
} from "@/db/schema";
import type { OutgoingEmail, SendOutcome } from "@/lib/email";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { sendFirstDraftsReady } from "@/server/first-week";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { stopLinkFor, verifiedStopLink } from "@/server/trial-email-links";
import {
  day3Date,
  TRIAL_NO_SEND_LINE,
  TRIAL_SIDE_DOOR_LINE,
  trialEmailCopy,
  trialEmailDue,
  type TrialEmailInput,
} from "@/server/trial-email-rules";
import { sendTrialEmails, stopTrialEmails } from "@/server/trial-emails";
import { createTestDb } from "../support/db";

// Eastern is UTC-4 in October 2026 (EDT), Pacific UTC-7 (PDT).
const MON_3PM_ET = new Date("2026-10-12T19:00:00Z");
const THU_3PM_ET = new Date("2026-10-15T19:00:00Z");

const trial = (over: Partial<TrialEmailInput> = {}): TrialEmailInput => ({
  status: "evaluating",
  evaluationStartedAt: MON_3PM_ET,
  evaluationEndsAt: THU_3PM_ET,
  paidAnything: false,
  stoppedAt: null,
  sent: [],
  digestHour: 7,
  timeZone: "America/New_York",
  ...over,
});

describe("when each email is due (owner's zone, morning hour, never at night)", () => {
  it("day 2: once the second day has started, inside the owner's daytime hours", () => {
    expect(trialEmailDue(trial(), new Date("2026-10-13T18:00:00Z"))).toBeNull(); // Tue 2pm: 23h in
    expect(trialEmailDue(trial(), new Date("2026-10-13T19:30:00Z"))).toBe("day2"); // Tue 3:30pm
    expect(trialEmailDue(trial(), new Date("2026-10-14T01:30:00Z"))).toBeNull(); // Tue 9:30pm
    expect(trialEmailDue(trial(), new Date("2026-10-14T10:30:00Z"))).toBeNull(); // Wed 6:30am
    expect(trialEmailDue(trial(), new Date("2026-10-14T11:15:00Z"))).toBe("day2"); // Wed 7:15am
    // Once only.
    expect(trialEmailDue(trial({ sent: ["day2"] }), new Date("2026-10-14T11:15:00Z"))).toBeNull();
    // A later morning hour moves it.
    expect(trialEmailDue(trial({ digestHour: 9 }), new Date("2026-10-14T11:15:00Z"))).toBeNull();
  });

  it("day 3: the morning of the last day — or the day before when it ends too early", () => {
    expect(day3Date(THU_3PM_ET, "America/New_York", 7)).toBe("2026-10-15");
    const thuEarly = new Date("2026-10-15T10:30:00Z"); // Thu 6:30am ET
    expect(day3Date(thuEarly, "America/New_York", 7)).toBe("2026-10-14");
    expect(
      trialEmailDue(trial({ sent: ["day2"] }), new Date("2026-10-15T11:05:00Z")), // Thu 7:05am
    ).toBe("day3");
    expect(trialEmailDue(trial({ sent: ["day2"] }), new Date("2026-10-14T15:00:00Z"))).toBeNull();
    // Day 3 wins a tie, and day 2 never goes after it.
    expect(trialEmailDue(trial(), new Date("2026-10-15T11:05:00Z"))).toBe("day3");
    expect(trialEmailDue(trial({ sent: ["day3"] }), new Date("2026-10-15T12:00:00Z"))).toBeNull();
    // Not once it has ended.
    expect(trialEmailDue(trial(), new Date("2026-10-15T19:30:00Z"))).toBeNull();
  });

  it("in the owner's own zone: a Pacific owner hears at 7am Pacific, not 7am Eastern", () => {
    const pacific = trial({
      timeZone: "America/Los_Angeles",
      evaluationStartedAt: new Date("2026-10-12T22:00:00Z"),
      evaluationEndsAt: new Date("2026-10-15T22:00:00Z"), // Thu 3pm PT
      sent: ["day2"],
    });
    expect(trialEmailDue(pacific, new Date("2026-10-15T13:30:00Z"))).toBeNull(); // 6:30am PT
    expect(trialEmailDue(pacific, new Date("2026-10-15T14:30:00Z"))).toBe("day3"); // 7:30am PT
    // A broken zone reads as Eastern (as everywhere else).
    expect(
      trialEmailDue(
        trial({ timeZone: "Mars/Olympus", sent: ["day2"] }),
        new Date("2026-10-15T11:05:00Z"),
      ),
    ).toBe("day3");
  });

  it("a week after an unpaid trial ran out — for one week only", () => {
    const ended = trial({
      status: "evaluation_expired",
      evaluationStartedAt: new Date("2026-10-02T19:00:00Z"),
      evaluationEndsAt: new Date("2026-10-05T19:00:00Z"),
    });
    expect(trialEmailDue(ended, new Date("2026-10-11T19:30:00Z"))).toBeNull(); // 6 days
    expect(trialEmailDue(ended, new Date("2026-10-12T19:30:00Z"))).toBe("after"); // 7 days
    expect(trialEmailDue(ended, new Date("2026-10-20T15:00:00Z"))).toBeNull(); // 15 days
    expect(
      trialEmailDue({ ...ended, sent: ["after"] }, new Date("2026-10-12T19:30:00Z")),
    ).toBeNull();
    expect(trialEmailDue(ended, new Date("2026-10-13T02:00:00Z"))).toBeNull(); // 10pm: night
  });

  it("never to anyone who paid anything, tapped Stop, or isn't on or just off the trial", () => {
    const at = new Date("2026-10-13T19:30:00Z");
    expect(trialEmailDue(trial({ paidAnything: true }), at)).toBeNull();
    expect(trialEmailDue(trial({ stoppedAt: at }), at)).toBeNull();
    for (const status of ["setup_paid", "active", "past_due", "canceled", "paused", "invited"])
      expect(trialEmailDue(trial({ status }), at), status).toBeNull();
  });
});

describe("what they say: counts only, one button, the trial's true sending line", () => {
  const counts = { sorted: 14, drafted: 6, waitingDrafts: 3, needsYou: 1 };
  const urls = { queueUrl: "https://app.test/queue", billingUrl: "https://app.test/billing" };
  it("day 2 opens the queue; day 3 says when it ends; after says the drafts are still here", () => {
    const d2 = trialEmailCopy("day2", { counts, ...urls });
    expect(d2.button).toEqual({ label: "Open my queue", url: urls.queueUrl });
    expect(d2.lines.join(" ")).toContain("sorted 14 emails and written 6 drafts");
    expect(d2.lines.join(" ")).toContain(
      "Waiting for you: 3 replies drafted and 1 email that needs you.",
    );
    expect(d2.lines.join(" ")).toContain(`${TRIAL_NO_SEND_LINE} ${TRIAL_SIDE_DOOR_LINE}`);

    const d3 = trialEmailCopy("day3", {
      counts,
      ...urls,
      endsAt: THU_3PM_ET,
      timeZone: "America/New_York",
      now: new Date("2026-10-15T11:05:00Z"),
    });
    expect(d3.subject).toBe("Your trial ends today at 3:00 PM");
    expect(d3.button).toEqual({ label: "Choose a plan", url: urls.billingUrl });
    const early = trialEmailCopy("day3", {
      counts,
      ...urls,
      endsAt: new Date("2026-10-15T10:30:00Z"),
      timeZone: "America/New_York",
      now: new Date("2026-10-14T11:05:00Z"),
    });
    expect(early.subject).toBe("Your trial ends tomorrow at 6:30 AM");

    const after = trialEmailCopy("after", { counts, ...urls });
    expect(after.subject).toBe("Your drafts are still here");
    expect(after.button).toEqual({ label: "Choose a plan", url: urls.billingUrl });
  });
});

// ---------------------------------------------------------------------------------------------

let database: Database;
let workspaceId: string;
let sent: OutgoingEmail[];
let outcome: SendOutcome;
const send = async (e: OutgoingEmail) => {
  sent.push(e);
  return outcome;
};

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AUTH_SECRET = "test-secret-for-trial-email-links";
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  const box = await saveConnectedMailbox(workspace, {
    email: "owner@shop.com",
    refreshToken: "rt",
    grantedScopes: [],
  });
  await database
    .update(workspaces)
    .set({ status: "evaluating", evaluationStartedAt: MON_3PM_ET, evaluationEndsAt: THU_3PM_ET })
    .where(eq(workspaces.id, workspaceId));
  // A customer's email: none of it may reach a trial email.
  const [t] = await database
    .insert(threads)
    .values({
      mailboxId: box.id,
      gmailThreadId: "t1",
      inInbox: true,
      subject: "SECRET-SUBJECT",
      category: "quote_request",
      summary: "SECRET-SUMMARY",
      classifiedAt: new Date("2026-10-13T12:00:00Z"),
      lastMessageAt: new Date("2026-10-13T12:00:00Z"),
    })
    .returning();
  await database.insert(messages).values({
    threadId: t!.id,
    mailboxId: box.id,
    gmailMessageId: "m1",
    direction: "in",
    fromAddress: "dana@customer.test",
    fromName: "Dana SECRET-NAME",
    subject: "SECRET-SUBJECT",
    bodyText: "SECRET-BODY",
    sentAt: new Date("2026-10-13T12:00:00Z"),
  });
  sent = [];
  outcome = "sent";
});

const TUE_330PM = new Date("2026-10-13T19:30:00Z");
const ws = async () =>
  (await database.select().from(workspaces).where(eq(workspaces.id, workspaceId)))[0]!;

describe("sending", () => {
  it("day 2 goes once, with its key, the stop link and the one-click headers; no email content", async () => {
    expect(await sendTrialEmails(TUE_330PM, { send })).toEqual({
      sent: 1,
      failed: 0,
      notConfigured: false,
    });
    expect(sent).toHaveLength(1);
    const e = sent[0]!;
    expect(e.to).toBe("owner@shop.com");
    expect(e.idempotencyKey).toBe(`trial-${workspaceId}-day2`);
    const link = stopLinkFor(workspaceId)!;
    expect(e.text).toContain(`Stop these emails: ${link}`);
    expect(e.html).toContain("Stop these emails");
    expect(e.headers).toEqual({
      "List-Unsubscribe": `<${link}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    for (const secret of ["SECRET", "dana@customer.test"]) {
      expect(e.text).not.toContain(secret);
      expect(e.html).not.toContain(secret);
      expect(e.subject).not.toContain(secret);
    }
    expect(e.text).toContain(TRIAL_SIDE_DOOR_LINE);
    expect((await ws()).trialEmailsSent).toEqual(["day2"]);
    const logs = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "trial_email_sent"));
    expect(logs.map((l) => l.detail)).toEqual([{ kind: "day2" }]);
    // The next run (and the next day) sends nothing more until day 3.
    expect((await sendTrialEmails(new Date("2026-10-14T13:00:00Z"), { send })).sent).toBe(0);
    expect(sent).toHaveLength(1);
    expect((await sendTrialEmails(new Date("2026-10-15T11:05:00Z"), { send })).sent).toBe(1);
    expect(sent[1]!.idempotencyKey).toBe(`trial-${workspaceId}-day3`);
    expect(sent[1]!.subject).toBe("Your trial ends today at 3:00 PM");
    expect((await ws()).trialEmailsSent).toEqual(["day2", "day3"]);
  });

  it("integration: none when the only Gmail address is paused on the plan", async () => {
    await database
      .update(mailboxes)
      .set({ planPausedAt: new Date("2026-10-13T12:00:00Z") })
      .where(eq(mailboxes.workspaceId, workspaceId));
    expect((await sendTrialEmails(TUE_330PM, { send })).sent).toBe(0);
    expect(sent).toEqual([]);
    await database
      .update(mailboxes)
      .set({ planPausedAt: null })
      .where(eq(mailboxes.workspaceId, workspaceId));
    expect((await sendTrialEmails(TUE_330PM, { send })).sent).toBe(1);
  });

  it("at the owner's own hour in their zone, never at night", async () => {
    await database.insert(businessProfiles).values({
      workspaceId,
      timeZone: "America/Los_Angeles",
      digestHour: 8,
    });
    // Wed 5am Pacific (8am Eastern): too early for them.
    expect((await sendTrialEmails(new Date("2026-10-14T12:00:00Z"), { send })).sent).toBe(0);
    // Tue 8:30pm Pacific: too late.
    expect((await sendTrialEmails(new Date("2026-10-14T03:30:00Z"), { send })).sent).toBe(0);
    // Wed 8:10am Pacific.
    expect((await sendTrialEmails(new Date("2026-10-14T15:10:00Z"), { send })).sent).toBe(1);
  });

  it("without Resend set up: nothing sent, nothing marked", async () => {
    outcome = "not_configured";
    expect(await sendTrialEmails(TUE_330PM, { send })).toMatchObject({ notConfigured: true });
    expect((await ws()).trialEmailsSent).toEqual([]);
  });

  it("a failed send is tried again next run and never marked", async () => {
    const failing = async () => {
      throw new Error("Resend 500.");
    };
    expect(await sendTrialEmails(TUE_330PM, { send: failing })).toMatchObject({ failed: 1 });
    expect((await ws()).trialEmailsSent).toEqual([]);
  });

  it("GUARDRAIL: paid and read-only accounts get none; stopped ones get none", async () => {
    for (const set of [
      { status: "setup_paid" as const, setupPaidVia: "stripe" as const },
      { status: "active" as const, setupPaidVia: "stripe" as const },
      { status: "past_due" as const },
      { status: "canceled" as const },
      { status: "paused" as const },
    ]) {
      await database.update(workspaces).set(set).where(eq(workspaces.id, workspaceId));
      expect((await sendTrialEmails(TUE_330PM, { send })).sent, set.status).toBe(0);
    }
    await database
      .update(workspaces)
      .set({ status: "evaluating", setupPaidVia: null, trialEmailsStoppedAt: TUE_330PM })
      .where(eq(workspaces.id, workspaceId));
    expect((await sendTrialEmails(TUE_330PM, { send })).sent).toBe(0);
    expect(sent).toEqual([]);
  });

  it("a week after an unpaid trial ran out: 'still here'; not if anything was paid", async () => {
    await database
      .update(workspaces)
      .set({
        status: "evaluation_expired",
        evaluationStartedAt: new Date("2026-10-02T19:00:00Z"),
        evaluationEndsAt: new Date("2026-10-05T19:00:00Z"),
        stripeSubscriptionId: "sub_1",
      })
      .where(eq(workspaces.id, workspaceId));
    const weekLater = new Date("2026-10-12T19:30:00Z");
    expect((await sendTrialEmails(weekLater, { send })).sent).toBe(0);
    await database
      .update(workspaces)
      .set({ stripeSubscriptionId: null })
      .where(eq(workspaces.id, workspaceId));
    expect((await sendTrialEmails(weekLater, { send })).sent).toBe(1);
    expect(sent[0]!.subject).toBe("Your drafts are still here");
    expect(sent[0]!.idempotencyKey).toBe(`trial-${workspaceId}-after`);
    expect((await sendTrialEmails(weekLater, { send })).sent).toBe(0);
  });

  it("day 1 is the 'first drafts are ready' email: during the trial it has the trial line and the stop link", async () => {
    await database
      .update(workspaces)
      .set({ createdAt: new Date("2026-10-12T18:00:00Z") })
      .where(eq(workspaces.id, workspaceId));
    await database.insert(voiceProfiles).values({ workspaceId, status: "ready" });
    const { mailboxes } = await import("@/db/schema");
    const [box] = await database.select().from(mailboxes);
    await database
      .update(mailboxes)
      .set({ backfillCompletedAt: new Date("2026-10-12T20:00:00Z") })
      .where(eq(mailboxes.id, box!.id));
    const [t] = await database.select().from(threads);
    await database.insert(drafts).values({
      threadId: t!.id,
      mailboxId: box!.id,
      gmailDraftId: "d1",
      toAddress: "dana@customer.test",
      subject: "Re: x",
      body: "Hi",
      originalBody: "Hi",
      reason: "Drafted.",
      createdAt: new Date("2026-10-12T21:00:00Z"),
    });
    const at = new Date("2026-10-12T21:30:00Z");
    expect((await sendFirstDraftsReady(at, { send, push: undefined })).sent).toBe(1);
    expect(sent[0]!.text).toContain(TRIAL_SIDE_DOOR_LINE);
    expect(sent[0]!.text).toContain(`Stop these emails: ${stopLinkFor(workspaceId)}`);
  });
});

describe("Stop these emails", () => {
  const params = (w: string, s: string) => new URLSearchParams({ w, s });
  it("the link is signed per account; a changed or borrowed signature is refused", async () => {
    const link = new URL(stopLinkFor(workspaceId)!);
    expect(link.pathname).toBe("/api/emails/stop");
    const s = link.searchParams.get("s")!;
    expect(verifiedStopLink(link.searchParams)).toEqual({ workspaceId, kind: "trial" });
    expect(verifiedStopLink(params(workspaceId, `${s.slice(0, -1)}x`))).toBeNull();
    const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
    expect(verifiedStopLink(params(other.workspace.id, s))).toBeNull();
    expect(verifiedStopLink(params("not-a-uuid", s))).toBeNull();
    // No secret, no link at all.
    const saved = process.env.AUTH_SECRET;
    process.env.AUTH_SECRET = "";
    expect(stopLinkFor(workspaceId)).toBeNull();
    expect(verifiedStopLink(link.searchParams)).toBeNull();
    process.env.AUTH_SECRET = saved;
  });

  it("one click (GET) switches them off and lands on the page; a bad link changes nothing", async () => {
    const { GET, POST } = await import("@/app/api/emails/stop/route");
    const good = stopLinkFor(workspaceId)!;
    const bad = new NextRequest(good.replace(/s=[^&]+/, "s=forged"));
    const refused = await GET(bad);
    expect(refused.status).toBe(303);
    expect(refused.headers.get("location")).toMatch(/\/emails\/stopped\?link=bad$/);
    expect((await ws()).trialEmailsStoppedAt).toBeNull();
    expect((await POST(bad)).status).toBe(400);
    expect((await ws()).trialEmailsStoppedAt).toBeNull();

    const ok = await GET(new NextRequest(good));
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toMatch(/\/emails\/stopped$/);
    expect((await ws()).trialEmailsStoppedAt).not.toBeNull();
    // The mail app's own button (POST) works too, and a second stop changes nothing.
    expect((await POST(new NextRequest(good, { method: "POST" }))).status).toBe(200);
    expect(await stopTrialEmails(workspaceId, "settings")).toBe(false);
    expect((await sendTrialEmails(TUE_330PM, { send })).sent).toBe(0);
  });

  it("Settings → Morning email has the switch while the trial emails can still come", () => {
    const page = readFileSync("src/app/(app)/settings/morning-email/page.tsx", "utf8");
    expect(page).toContain("trialEmailsMatter(workspace)");
    expect(page).toContain('name="trialEmails"');
    const actions = readFileSync("src/app/(app)/settings/profile-actions.ts", "utf8");
    expect(actions).toMatch(
      /export async function saveTrialEmailsAction[\s\S]*?await requireOwner\(\)[\s\S]*?stopTrialEmails\(workspace\.id, "settings"\)/,
    );
  });
});
