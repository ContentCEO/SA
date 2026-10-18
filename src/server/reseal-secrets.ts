import { and, asc, eq, gt, like } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, mailboxes } from "@/db/schema";
import { decryptSecret, encryptSecret, sealedWithCurrentKey } from "@/lib/crypto";

/**
 * Check 26 P7: after TOKEN_ENCRYPTION_KEY is replaced (the old one moved to
 * TOKEN_ENCRYPTION_KEY_PREVIOUS), re-seal every stored secret with the new key — each mailbox's
 * Gmail refresh token and each encrypted app_settings value (the Stripe webhook secret). In
 * batches, idempotent and safe to re-run: a row already on the current key is left alone, and
 * each update only lands if the row still holds what was read. Counts only, never a value.
 */
export type ResealCounts = { resealed: number; current: number; unreadable: number };

export async function resealSecrets(
  batchSize = 100,
): Promise<{ mailboxes: ResealCounts; settings: ResealCounts }> {
  const counts = () => ({ resealed: 0, current: 0, unreadable: 0 });
  const out = { mailboxes: counts(), settings: counts() };

  /** One sealed value: what to write instead, or why not. */
  const reseal = (sealed: string, c: ResealCounts): string | null => {
    if (sealedWithCurrentKey(sealed)) {
      c.current += 1;
      return null;
    }
    try {
      return encryptSecret(decryptSecret(sealed));
    } catch {
      c.unreadable += 1;
      return null;
    }
  };

  let after = "";
  for (;;) {
    const rows = await db()
      .select({ id: mailboxes.id, sealed: mailboxes.encryptedRefreshToken })
      .from(mailboxes)
      .where(after ? gt(mailboxes.id, after) : undefined)
      .orderBy(asc(mailboxes.id))
      .limit(batchSize);
    for (const row of rows) {
      const next = reseal(row.sealed, out.mailboxes);
      if (next === null) continue;
      const done = await db()
        .update(mailboxes)
        .set({ encryptedRefreshToken: next })
        .where(and(eq(mailboxes.id, row.id), eq(mailboxes.encryptedRefreshToken, row.sealed)))
        .returning({ id: mailboxes.id });
      // Changed meanwhile (a reconnect sealed a new token with the current key): nothing to do.
      if (done.length) out.mailboxes.resealed += 1;
      else out.mailboxes.current += 1;
    }
    if (rows.length < batchSize) break;
    after = rows[rows.length - 1]!.id;
  }

  // Only sealed values (the "v1." format) are secrets; every other setting is a plain marker.
  let afterKey = "";
  for (;;) {
    const rows = await db()
      .select({ key: appSettings.key, sealed: appSettings.value })
      .from(appSettings)
      .where(
        and(like(appSettings.value, "v1.%"), afterKey ? gt(appSettings.key, afterKey) : undefined),
      )
      .orderBy(asc(appSettings.key))
      .limit(batchSize);
    for (const row of rows) {
      const next = reseal(row.sealed, out.settings);
      if (next === null) continue;
      const done = await db()
        .update(appSettings)
        .set({ value: next })
        .where(and(eq(appSettings.key, row.key), eq(appSettings.value, row.sealed)))
        .returning({ key: appSettings.key });
      if (done.length) out.settings.resealed += 1;
      else out.settings.current += 1;
    }
    if (rows.length < batchSize) break;
    afterKey = rows[rows.length - 1]!.key;
  }
  return out;
}
