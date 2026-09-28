import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { activityLog, invites, mailboxes, workspaces } from "@/db/schema";
import type { MailboxConnector } from "@/mailbox/connector";
import { ensureUserAndWorkspace, isAllowedToSignIn } from "@/server/accounts";
import {
  MailboxLimitError,
  disconnectMailbox,
  listMailboxes,
  saveConnectedMailbox,
} from "@/server/mailboxes";
import { decryptSecret } from "@/lib/crypto";
import { createTestDb } from "../support/db";

let database: Database;

beforeEach(async () => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.ADMIN_EMAIL = "davi@example.com";
  database = await createTestDb();
});

function fakeConnector(revoke = vi.fn().mockResolvedValue(undefined)): MailboxConnector {
  return {
    provider: "gmail",
    requiredScopes: [],
    authorizationUrl: () => "",
    exchangeCode: vi.fn(),
    revoke,
  };
}

const connect = (email: string, refreshToken = "rt-" + email) => ({
  email,
  refreshToken,
  grantedScopes: ["a", "b"],
});

describe("invite-only sign-in", () => {
  it("lets in invited emails (case-insensitive) and the admin, and nobody else", async () => {
    await database.insert(invites).values({ email: "owner@shop.com", trade: "plumbing" });
    expect(await isAllowedToSignIn("Owner@Shop.com")).toBe(true);
    expect(await isAllowedToSignIn("DAVI@example.com")).toBe(true);
    expect(await isAllowedToSignIn("stranger@shop.com")).toBe(false);
  });

  it("creates one user and one workspace no matter how often they sign in", async () => {
    await database.insert(invites).values({ email: "owner@shop.com", trade: "electrical" });
    const first = await ensureUserAndWorkspace({ email: "Owner@Shop.com", name: "Dana" });
    const second = await ensureUserAndWorkspace({ email: "owner@shop.com", name: null });
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.name).toBe("Dana");
    expect(second.workspace.id).toBe(first.workspace.id);
    expect(first.workspace.status).toBe("invited");
    expect(first.workspace.trade).toBe("electrical");
    const [invite] = await database.select().from(invites);
    expect(invite!.acceptedAt).not.toBeNull();
  });
});

describe("mailboxes", () => {
  it("stores the refresh token encrypted and never lists it", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "o@shop.com" });
    await saveConnectedMailbox(workspace, connect("o@shop.com", "super-secret-token"));

    const [row] = await database.select().from(mailboxes);
    expect(row!.encryptedRefreshToken).not.toContain("super-secret-token");
    expect(decryptSecret(row!.encryptedRefreshToken)).toBe("super-secret-token");

    const listed = await listMailboxes(workspace.id);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("super-secret-token");
    expect(Object.keys(listed[0]!)).not.toContain("encryptedRefreshToken");
  });

  it("allows one mailbox during evaluation, but reconnecting the same one is fine", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "o@shop.com" });
    await saveConnectedMailbox(workspace, connect("o@shop.com", "first"));
    await database.update(mailboxes).set({ status: "reconnect_needed" });

    const again = await saveConnectedMailbox(workspace, connect("O@shop.com", "second"));
    expect(again.status).toBe("active");
    const rows = await database.select().from(mailboxes);
    expect(rows).toHaveLength(1);
    expect(decryptSecret(rows[0]!.encryptedRefreshToken)).toBe("second");

    await expect(saveConnectedMailbox(workspace, connect("other@shop.com"))).rejects.toBeInstanceOf(
      MailboxLimitError,
    );
  });

  it("enforces the Crew limit of three", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "o@shop.com" });
    await database.update(workspaces).set({ plan: "crew" }).where(eq(workspaces.id, workspace.id));
    const crew = { ...workspace, plan: "crew" as const };
    for (const e of ["a@x.com", "b@x.com", "c@x.com"]) await saveConnectedMailbox(crew, connect(e));
    await expect(saveConnectedMailbox(crew, connect("d@x.com"))).rejects.toBeInstanceOf(
      MailboxLimitError,
    );
  });

  it("disconnect revokes at Google, deletes the mailbox, and logs it", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "o@shop.com" });
    const m = await saveConnectedMailbox(workspace, connect("o@shop.com", "tok"));
    const revoke = vi.fn().mockResolvedValue(undefined);

    expect(await disconnectMailbox(workspace.id, m.id, fakeConnector(revoke))).toBe(true);
    expect(revoke).toHaveBeenCalledWith("tok");
    expect(await database.select().from(mailboxes)).toHaveLength(0);

    const log = await database
      .select()
      .from(activityLog)
      .where(eq(activityLog.action, "mailbox_disconnected"));
    expect(log).toHaveLength(1);
    expect(log[0]!.detail).toMatchObject({ revokedAtProvider: true });
    expect(JSON.stringify(log[0]!.detail)).not.toContain("tok");
  });

  it("still deletes our copy if Google's revoke fails", async () => {
    const { workspace } = await ensureUserAndWorkspace({ email: "o@shop.com" });
    const m = await saveConnectedMailbox(workspace, connect("o@shop.com"));
    const revoke = vi.fn().mockRejectedValue(new Error("down"));
    expect(await disconnectMailbox(workspace.id, m.id, fakeConnector(revoke))).toBe(true);
    expect(await database.select().from(mailboxes)).toHaveLength(0);
  });

  it("won't disconnect a mailbox from someone else's workspace", async () => {
    const a = await ensureUserAndWorkspace({ email: "a@shop.com" });
    const b = await ensureUserAndWorkspace({ email: "b@shop.com" });
    const m = await saveConnectedMailbox(a.workspace, connect("a@shop.com"));
    const revoke = vi.fn();

    expect(await disconnectMailbox(b.workspace.id, m.id, fakeConnector(revoke))).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    expect(await database.select().from(mailboxes)).toHaveLength(1);
  });
});
