import "server-only";
import { sql } from "drizzle-orm";
import { utcDay } from "@/ai/usage";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import type { EmailSender } from "@/lib/email";
import { notifyAdminOnce } from "./admin-notify";

/**
 * Check 48 P3: a model Anthropic says is missing. `model_down:<model>:<UTC day>` holds the first
 * time we saw it that day (for /admin's System box); Davi gets one content-free email per model
 * per UTC day. Never throws: the caller is already handling the model error.
 */
export async function recordModelDown(
  model: string,
  now: Date = new Date(),
  deps: { send?: EmailSender; timeoutMs?: number } = {},
): Promise<void> {
  const day = utcDay(now);
  try {
    await db()
      .insert(appSettings)
      .values({ key: `model_down:${model}:${day}`, value: now.toISOString() })
      .onConflictDoNothing();
    // Raced against a timer: a slow email service never holds up the job or the owner's tap.
    await raceTimeout(
      notifyAdminOnce(
        `model_alert:${model}:${day}`,
        {
          subject: `Sorting is stopped: ${model} is not available`,
          serif: "heads up,",
          heavy: "a model is missing.",
          lines: [
            `Sorting is stopped: ${model} is not available. Owners' mail is waiting.`,
            "Nothing is lost. Waiting mail is sorted again once the model answers, or once a stand-in model is approved in src/config/models.ts.",
          ],
        },
        { send: deps.send, now },
      ),
      deps.timeoutMs ?? 5_000,
    );
  } catch (err) {
    console.error("model_alert_failed", {
      model,
      error: err instanceof Error ? err.name : "unknown",
    });
  }
}

/** Models seen missing today, with the first time each was seen. Model names and times only. */
export async function modelsDownToday(
  now: Date = new Date(),
): Promise<{ model: string; since: Date }[]> {
  const day = utcDay(now);
  const rows = await db()
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(sql`${appSettings.key} like ${`model_down:%:${day}`}`);
  return rows
    .map((r) => ({ model: r.key.split(":")[1] ?? "", since: new Date(r.value) }))
    .filter((r) => r.model && !Number.isNaN(r.since.getTime()))
    .sort((a, b) => a.since.getTime() - b.since.getTime());
}

async function raceTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error("Timed out.");
          err.name = "TimeoutError";
          reject(err);
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
