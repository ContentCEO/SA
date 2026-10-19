import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { appSettings, mailboxes } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { resealSecrets } from "@/server/reseal-secrets";
import { createTestDb } from "../support/db";

/**
 * Check 26 P7: TOKEN_ENCRYPTION_KEY can be replaced without disconnecting anyone. The old key
 * goes in TOKEN_ENCRYPTION_KEY_PREVIOUS, everything still opens, `pnpm reseal:secrets` moves
 * every stored secret to the new key, and then the old key can go.
 */
const OLD = randomBytes(32).toString("base64");
const NEW = randomBytes(32).toString("base64");

function useKeys(current: string, previous?: string) {
  process.env.TOKEN_ENCRYPTION_KEY = current;
  if (previous) process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS = previous;
  else delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
}
afterEach(() => {
  delete process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
});

describe("decryptSecret with a previous key", () => {
  it("a value sealed with the old key opens when the old key is set as previous", () => {
    useKeys(OLD);
    const sealed = encryptSecret("rt-1");
    useKeys(NEW, OLD);
    expect(decryptSecret(sealed)).toBe("rt-1");
  });

  it("GUARDRAIL: and fails when it isn't", () => {
    useKeys(OLD);
    const sealed = encryptSecret("rt-1");
    useKeys(NEW);
    expect(() => decryptSecret(sealed)).toThrow();
  });

  it("new values always use the current key", () => {
    useKeys(NEW, OLD);
    const sealed = encryptSecret("rt-2");
    expect(decryptSecret(sealed, NEW)).toBe("rt-2");
    expect(() => decryptSecret(sealed, OLD)).toThrow();
  });

  it("a malformed previous key is refused, the same as the current one", () => {
    useKeys(OLD);
    const sealed = encryptSecret("rt-1");
    useKeys(NEW, "too-short");
    expect(() => decryptSecret(sealed)).toThrow(/TOKEN_ENCRYPTION_KEY_PREVIOUS must be 32 bytes/);
  });
});

describe("pnpm reseal:secrets", () => {
  let database: Database;
  beforeEach(async () => {
    useKeys(OLD);
    database = await createTestDb();
  });

  it("leaves every row readable with only the new key, and is safe to re-run", async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 5; i++) {
      const { workspace } = await ensureUserAndWorkspace({ email: `owner${i}@shop.com` });
      tokens.push(`rt-${i}`);
      await database.insert(mailboxes).values({
        workspaceId: workspace.id,
        email: `owner${i}@shop.com`,
        encryptedRefreshToken: encryptSecret(`rt-${i}`),
        scopes: "",
      });
    }
    await database.insert(appSettings).values([
      { key: "stripe:webhook-secret", value: encryptSecret("whsec_1") },
      { key: "backfill:m7-v1", value: "done" },
    ]);

    useKeys(NEW, OLD);
    // Small batches, so the paging is exercised.
    const first = await resealSecrets(2);
    expect(first.mailboxes).toEqual({ resealed: 5, current: 0, unreadable: 0 });
    expect(first.settings).toEqual({ resealed: 1, current: 0, unreadable: 0 });

    useKeys(NEW); // the previous key removed
    const rows = await database.select().from(mailboxes);
    expect(rows.map((r) => decryptSecret(r.encryptedRefreshToken)).sort()).toEqual(tokens);
    const settings = await database.select().from(appSettings);
    expect(decryptSecret(settings.find((s) => s.key === "stripe:webhook-secret")!.value)).toBe(
      "whsec_1",
    );
    expect(settings.find((s) => s.key === "backfill:m7-v1")!.value).toBe("done");

    const again = await resealSecrets(2);
    expect(again.mailboxes).toEqual({ resealed: 0, current: 5, unreadable: 0 });
    expect(again.settings).toEqual({ resealed: 0, current: 1, unreadable: 0 });
  });
});
