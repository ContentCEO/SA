import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { activityLog, businessProfiles, threads } from "@/db/schema";
import type { OutgoingEmail } from "@/lib/email";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { accessLostEmail } from "@/server/alerts";
import { sendDigests } from "@/server/digest";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { stopLinkFor, verifiedStopLink } from "@/server/trial-email-links";
import { createTestDb } from "../support/db";

/** Check 18 P9: List-Unsubscribe on the morning and monthly emails, turning only that switch off. */

const NOW = new Date("2026-10-06T11:30:00Z"); // 7:30am New York

let database: Database;
let workspaceId: string;
let sent: OutgoingEmail[];
const send = async (e: OutgoingEmail) => {
  sent.push(e);
  return "sent" as const;
};

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AUTH_SECRET = "test-secret-at-least-16-chars";
  database = await createTestDb();
  const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
  workspaceId = workspace.id;
  const mailboxId = (
    await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt",
      grantedScopes: [],
    })
  ).id;
  await database.insert(threads).values({
    mailboxId,
    gmailThreadId: "g1",
    inInbox: true,
    category: "complaint",
    needsOwner: true,
    classifiedAt: new Date(NOW.getTime() - 3600_000),
    lastMessageAt: new Date(NOW.getTime() - 3600_000),
  });
  sent = [];
});
afterEach(() => {
  delete process.env.AUTH_SECRET;
});

const enabled = async () =>
  (
    await database
      .select()
      .from(businessProfiles)
      .where(eq(businessProfiles.workspaceId, workspaceId))
  )[0]?.digestEnabled ?? true;
const offRows = async () =>
  (await database.select().from(activityLog)).filter((r) => r.action === "digest_turned_off");

describe("the headers", () => {
  it("are on the morning and monthly emails, and not on alerts or invites", async () => {
    await sendDigests(NOW, { send });
    expect(sent).toHaveLength(1);
    const link = stopLinkFor(workspaceId, "digest")!;
    expect(sent[0]!.headers).toEqual({
      "List-Unsubscribe": `<${link}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(link).toContain("k=digest");
    expect(link).not.toContain("@");

    // The monthly summary's header: asserted in monthly-summary.test.ts's send test.

    // Alerts and invites build no headers (the alert builder returns none; invites pass none).
    expect(accessLostEmail("owner@shop.com", false, "testing")).not.toHaveProperty("headers");
    const invite = readFileSync("src/server/invite-email.ts", "utf8");
    const alerts = readFileSync("src/server/alerts.ts", "utf8");
    for (const src of [invite, alerts])
      expect(src).not.toMatch(/headers:|stopHeaders|digestStopHeaders/);
  });

  it("a trial link never turns the morning email off (each kind signs its own purpose)", () => {
    const trial = new URL(stopLinkFor(workspaceId)!);
    const forged = new URLSearchParams(trial.searchParams);
    forged.set("k", "digest");
    expect(verifiedStopLink(forged)).toBeNull();
    const digest = new URL(stopLinkFor(workspaceId, "digest")!);
    expect(verifiedStopLink(digest.searchParams)).toEqual({ workspaceId, kind: "digest" });
    const asTrial = new URLSearchParams(digest.searchParams);
    asTrial.delete("k");
    expect(verifiedStopLink(asTrial)).toBeNull();
  });
});

describe("/api/emails/stop?k=digest", () => {
  it("a bad token gets 403 and changes nothing", async () => {
    const { GET, POST } = await import("@/app/api/emails/stop/route");
    const good = stopLinkFor(workspaceId, "digest")!;
    const bad = good.replace(/s=[^&]+/, "s=forged");
    expect((await POST(new NextRequest(bad, { method: "POST" }))).status).toBe(403);
    const g = await GET(new NextRequest(bad));
    expect(g.headers.get("location")).toMatch(/\/emails\/stopped\?kind=digest$/);
    expect(await enabled()).toBe(true);
    expect(await offRows()).toEqual([]);
  });

  it("GET changes nothing: it lands on a page whose button posts back", async () => {
    const { GET } = await import("@/app/api/emails/stop/route");
    const r = await GET(new NextRequest(stopLinkFor(workspaceId, "digest")!));
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toMatch(/\/emails\/stopped\?kind=digest&w=[0-9a-f-]+&s=/);
    expect(await enabled()).toBe(true);
    expect(await offRows()).toEqual([]);
  });

  it("POST (one-click) turns the email off once and logs one activity row with no address", async () => {
    const { POST } = await import("@/app/api/emails/stop/route");
    const good = stopLinkFor(workspaceId, "digest")!;
    const oneClick = () =>
      POST(
        new NextRequest(good, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "List-Unsubscribe=One-Click",
        }),
      );
    const r = await oneClick();
    expect(r.status).toBe(200);
    expect(await enabled()).toBe(false);
    expect((await oneClick()).status).toBe(200);
    const rows = await offRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.actor).toBe("owner");
    expect(rows[0]!.detail).toEqual({ via: "unsubscribe" });
    expect(JSON.stringify(rows)).not.toContain("@");
    // Only that switch: no morning email (or monthly) afterwards.
    await sendDigests(NOW, { send });
    expect(sent).toEqual([]);
  });

  it("the page's button lands on the confirmation", async () => {
    const { POST } = await import("@/app/api/emails/stop/route");
    const r = await POST(
      new NextRequest(stopLinkFor(workspaceId, "digest")!, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "from=page",
      }),
    );
    expect(r.status).toBe(303);
    expect(r.headers.get("location")).toMatch(/\/emails\/stopped\?kind=digest&done=1$/);
    expect(await enabled()).toBe(false);
  });
});
