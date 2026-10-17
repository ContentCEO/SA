import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { activityLog, mailboxes, workspaces } from "@/db/schema";
import type { OutgoingEmail } from "@/lib/email";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { accessLostEmail, ACCESS_REMINDER_AFTER_MS, sendAccessLostAlerts } from "@/server/alerts";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { markReconnectNeeded } from "@/server/sync";
import { createTestDb } from "../support/db";

let database: Database;
let sent: OutgoingEmail[];
const send = async (e: OutgoingEmail) => {
  sent.push(e);
  return "sent" as const;
};
const NOW = new Date("2026-10-10T14:00:00Z");
const after = (ms: number) => new Date(NOW.getTime() + ms);

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.APP_URL = "https://app.example";
  database = await createTestDb();
  sent = [];
});

async function seed() {
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  await database
    .update(workspaces)
    .set({ status: "active" })
    .where(eq(workspaces.id, workspace.id));
  const mb = await saveConnectedMailbox(workspace, {
    email: "jobs@shop.com",
    refreshToken: "rt",
    grantedScopes: [],
  });
  return { workspace, mailboxId: mb.id };
}

describe("Gmail access lost alerts", () => {
  it("emails once, reminds once after two days, then stops", async () => {
    const { workspace, mailboxId } = await seed();
    expect((await sendAccessLostAlerts(NOW, { send })).sent).toBe(0); // connected: nothing

    await markReconnectNeeded({ id: mailboxId, workspaceId: workspace.id });
    expect((await sendAccessLostAlerts(NOW, { send })).sent).toBe(1);
    expect(sent[0]!.to).toBe("owner@shop.com");
    expect(sent[0]!.subject).toMatch(/lost access/);
    expect(sent[0]!.text).toContain("https://app.example/settings/gmail");

    expect((await sendAccessLostAlerts(after(60_000), { send })).sent).toBe(0);
    expect((await sendAccessLostAlerts(after(ACCESS_REMINDER_AFTER_MS + 1), { send })).sent).toBe(
      1,
    );
    expect(sent[1]!.subject).toMatch(/Reminder/);
    expect((await sendAccessLostAlerts(after(10 * ACCESS_REMINDER_AFTER_MS), { send })).sent).toBe(
      0,
    );
  });

  it("reconnecting resets it, so a later loss alerts again", async () => {
    const { workspace, mailboxId } = await seed();
    await markReconnectNeeded({ id: mailboxId, workspaceId: workspace.id });
    await sendAccessLostAlerts(NOW, { send });
    await saveConnectedMailbox(workspace, {
      email: "jobs@shop.com",
      refreshToken: "rt2",
      grantedScopes: [],
    });
    const [mb] = await database.select().from(mailboxes);
    expect(mb!.accessAlertsSent).toBe(0);
    expect(mb!.accessLostAt).toBeNull();
    await markReconnectNeeded({ id: mailboxId, workspaceId: workspace.id });
    expect((await sendAccessLostAlerts(after(60_000), { send })).sent).toBe(1);
  });

  it("read-only accounts aren't nagged, and nothing is marked when email isn't set up", async () => {
    const { workspace, mailboxId } = await seed();
    await markReconnectNeeded({ id: mailboxId, workspaceId: workspace.id });
    await database
      .update(workspaces)
      .set({ status: "canceled" })
      .where(eq(workspaces.id, workspace.id));
    expect((await sendAccessLostAlerts(NOW, { send })).sent).toBe(0);

    await database
      .update(workspaces)
      .set({ status: "active" })
      .where(eq(workspaces.id, workspace.id));
    const r = await sendAccessLostAlerts(NOW, { send: async () => "not_configured" });
    expect(r.notConfigured).toBe(true);
    const [mb] = await database.select().from(mailboxes);
    expect(mb!.accessAlertsSent).toBe(0);
  });

  it("GUARD: an earlier try that got through (already sent) is counted once, not resent", async () => {
    const { workspace, mailboxId } = await seed();
    await markReconnectNeeded({ id: mailboxId, workspaceId: workspace.id });
    const alreadySent = async (e: OutgoingEmail) => {
      sent.push(e);
      return "already_sent" as const;
    };
    expect((await sendAccessLostAlerts(NOW, { send: alreadySent })).sent).toBe(1);
    const [mb] = await database.select().from(mailboxes);
    expect(mb!.accessAlertsSent).toBe(1);
    const logged = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "access_alert_sent"));
    expect(logged).toHaveLength(1);

    // Within the two-day window nothing more goes out (and nothing more is logged).
    expect((await sendAccessLostAlerts(after(60 * 60_000), { send: alreadySent })).sent).toBe(0);
    expect(sent).toHaveLength(1);
    expect(
      await database.select().from(activityLog).where(eq(activityLog.action, "access_alert_sent")),
    ).toHaveLength(1);
  });

  it("Check 18 P1: one refused email doesn't stop the next owner's alert, and is retried", async () => {
    const first = await seed();
    const { workspace: ws2 } = await ensureUserAndWorkspace({ email: "second@shop.com" });
    await database.update(workspaces).set({ status: "active" }).where(eq(workspaces.id, ws2.id));
    const mb2 = await saveConnectedMailbox(ws2, {
      email: "office@second.com",
      refreshToken: "rt",
      grantedScopes: [],
    });
    await markReconnectNeeded({ id: first.mailboxId, workspaceId: first.workspace.id });
    await markReconnectNeeded({ id: mb2.id, workspaceId: ws2.id });

    const errors: unknown[][] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    const refusing = async (e: OutgoingEmail) => {
      if (e.to === "owner@shop.com") throw new Error("Resend 403.");
      sent.push(e);
      return "sent" as const;
    };
    let r;
    try {
      r = await sendAccessLostAlerts(NOW, { send: refusing });
    } finally {
      console.error = orig;
    }
    expect(r).toEqual({ sent: 1, failed: 1, notConfigured: false });
    expect(sent.map((e) => e.to)).toEqual(["second@shop.com"]);
    // Ids and the error's name only — never the message or an address.
    expect(errors).toEqual([
      ["access_alert_failed", { mailboxId: first.mailboxId, error: "Error" }],
    ]);
    const rows = await database.select().from(mailboxes);
    expect(rows.find((m) => m.id === first.mailboxId)!.accessAlertsSent).toBe(0);
    expect(rows.find((m) => m.id === mb2.id)!.accessAlertsSent).toBe(1);

    // The next run tries the first owner again (and only them).
    const again = await sendAccessLostAlerts(after(15 * 60_000), { send });
    expect(again).toEqual({ sent: 1, failed: 0, notConfigured: false });
    expect(sent.map((e) => e.to)).toEqual(["second@shop.com", "owner@shop.com"]);
  });

  it("names only the owner's own mailbox", () => {
    const e = accessLostEmail("jobs@shop.com", false);
    expect(e.text).toContain("jobs@shop.com");
    expect(e.html).toContain("Reconnect Gmail");
  });
});
