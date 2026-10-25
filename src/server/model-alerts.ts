import "server-only";
import { sql } from "drizzle-orm";
import { utcDay } from "@/ai/usage";
import { db } from "@/db";
import { appSettings } from "@/db/schema";
import type { ModelRole } from "@/config/models";
import { emailErrorFields, type EmailSender } from "@/lib/email";
import { isModelRole, modelDownEmail } from "./model-alert-rules";
import { notifyAdminOnce, withTimeoutMs } from "./admin-notify";

/**
 * Check 48 P3: a model Anthropic says is missing. `model_down:<role>:<model>:<UTC day>` holds the
 * first time we saw it that day for that part of the app (for /admin's System box); Davi gets one
 * content-free email per role and model per UTC day, naming the part that stopped (sorting,
 * drafting or voice learning: one model can serve two roles). Never throws: the caller is
 * already handling the model error.
 */
export async function recordModelDown(
  role: ModelRole,
  model: string,
  now: Date = new Date(),
  deps: { send?: EmailSender; timeoutMs?: number } = {},
): Promise<void> {
  const day = utcDay(now);
  try {
    await db()
      .insert(appSettings)
      .values({ key: `model_down:${role}:${model}:${day}`, value: now.toISOString() })
      .onConflictDoNothing();
    // Raced against a timer: a slow email service never holds up the job or the owner's tap.
    await withTimeoutMs(
      notifyAdminOnce(
        `model_alert:${role}:${model}:${day}`,
        {
          ...modelDownEmail(role, model),
          serif: "heads up,",
          heavy: "a model is missing.",
        },
        { send: deps.send, now },
      ),
      deps.timeoutMs ?? 5_000,
    );
  } catch (err) {
    console.error("model_alert_failed", { role, model, ...emailErrorFields(err) });
  }
}

/**
 * Models seen missing today, per part of the app, with the first time each was seen. Roles,
 * model names and times only.
 */
export async function modelsDownToday(
  now: Date = new Date(),
): Promise<{ role: ModelRole; model: string; since: Date }[]> {
  const day = utcDay(now);
  const rows = await db()
    .select({ key: appSettings.key, value: appSettings.value })
    .from(appSettings)
    .where(sql`${appSettings.key} like ${`model_down:%:${day}`}`);
  return rows
    .flatMap((r) => {
      const [, role = "", model = ""] = r.key.split(":");
      const since = new Date(r.value);
      return isModelRole(role) && model && !Number.isNaN(since.getTime())
        ? [{ role, model, since }]
        : [];
    })
    .sort((a, b) => a.since.getTime() - b.since.getTime());
}
