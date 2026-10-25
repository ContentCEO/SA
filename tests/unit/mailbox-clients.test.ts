import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { mailboxes } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { mailboxClientFor } from "@/mailbox/clients";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { saveConnectedMailbox, saveRotatedRefreshToken } from "@/server/mailboxes";
import { ROOT, rel, sourceFiles } from "../support/source-ast";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestDb } from "../support/db";

/** Check 47 P2: every mailbox client comes from one provider switch. */

beforeEach(() => {
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.AUTH_GOOGLE_ID = "id";
  process.env.AUTH_GOOGLE_SECRET = "secret";
});

describe("mailboxClientFor", () => {
  it("builds a working Gmail client for provider gmail", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "at" })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ emailAddress: "o@x.com", historyId: "7" })),
      );
    vi.stubGlobal("fetch", f);
    const c = mailboxClientFor({
      id: "m1",
      provider: "gmail",
      encryptedRefreshToken: encryptSecret("rt-1"),
    });
    await expect(c.getProfile()).resolves.toEqual({ emailAddress: "o@x.com", historyId: "7" });
    expect(String(f.mock.calls[0]![1].body)).toContain("refresh_token=rt-1");
    vi.unstubAllGlobals();
  });

  it("an unknown provider throws", () => {
    expect(() =>
      mailboxClientFor({
        id: "m1",
        provider: "yahoo" as unknown as "gmail",
        encryptedRefreshToken: encryptSecret("x"),
      }),
    ).toThrow(/No mailbox client for provider yahoo/);
  });

  it("plan #49: provider outlook gets the Outlook client (tested in outlook-writer.test.ts)", () => {
    const c = mailboxClientFor({
      id: "m1",
      provider: "outlook",
      encryptedRefreshToken: encryptSecret("x"),
    });
    expect(typeof c.sendDraft).toBe("function");
    expect(c.gmailUnits).toBeUndefined();
  });
});

describe("a rotated refresh token is kept", () => {
  it("saveRotatedRefreshToken stores it encrypted", async () => {
    const database: Database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    const m = await saveConnectedMailbox(workspace, {
      email: "owner@shop.com",
      refreshToken: "rt-old",
      grantedScopes: ["x"],
    });
    await saveRotatedRefreshToken(m.id, "rt-new");
    const [row] = await database.select().from(mailboxes).where(eq(mailboxes.id, m.id));
    expect(row!.encryptedRefreshToken).not.toContain("rt-new");
    expect(decryptSecret(row!.encryptedRefreshToken)).toBe("rt-new");
  });
});

describe("GUARDRAIL: only src/mailbox/ builds a provider's client", () => {
  it("nothing outside src/mailbox/ imports createGmailReader from @/mailbox/gmail/api", () => {
    const offenders = sourceFiles()
      .map((f) => rel(f))
      .filter((f) => !f.startsWith("src/mailbox/"))
      .filter((f) => {
        const text = readFileSync(join(ROOT, f), "utf8");
        return /from\s+["']@\/mailbox\/gmail\/api["']/.test(text) && /createGmailReader/.test(text);
      });
    expect(offenders).toEqual([]);
  });
});
