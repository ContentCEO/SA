import "server-only";
import { eq, like } from "drizzle-orm";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import { isHandKey, LAUNCH_TICK_PREFIX, type HandKey, type LaunchFacts } from "./launch-ready";

/** The app_settings key Connect Stripe stores its webhook signing secret under. */
const WEBHOOK_SECRET_KEY = "stripe_webhook_secret";

/**
 * Check 50 P6: what /admin's "Ready for paying owners" needs from the database. Reads the tick
 * dates and only whether a webhook secret exists — never its value.
 */
export async function loadLaunchFacts(): Promise<LaunchFacts> {
  const tickRows = await db()
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(like(appSettings.key, `${LAUNCH_TICK_PREFIX}%`));
  // Only whether the row exists: the secret itself is never selected.
  const [webhook] = await db()
    .select({ key: appSettings.key })
    .from(appSettings)
    .where(eq(appSettings.key, WEBHOOK_SECRET_KEY));
  const ticks: Partial<Record<HandKey, Date>> = {};
  for (const r of tickRows) {
    const key = r.key.slice(LAUNCH_TICK_PREFIX.length);
    const at = new Date(r.value);
    if (isHandKey(key) && !Number.isNaN(at.getTime())) ticks[key] = at;
  }
  return { webhookSecretStored: !!webhook, ticks };
}

/** Davi's Done on a hand row. Writes only app_settings; nothing reads it as a gate. */
export async function tickLaunchItem(key: HandKey, now: Date = new Date()) {
  await db()
    .insert(appSettings)
    .values({ key: `${LAUNCH_TICK_PREFIX}${key}`, value: now.toISOString(), updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: now.toISOString(), updatedAt: now },
    });
}
