import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { mailboxes, workspaces } from "@/db/schema";
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
    expect(sent[0]!.text).toContain("https://app.example/settings");

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

  it("names only the owner's own mailbox", () => {
    const e = accessLostEmail("jobs@shop.com", false);
    expect(e.text).toContain("jobs@shop.com");
    expect(e.html).toContain("Reconnect Gmail");
  });
});
