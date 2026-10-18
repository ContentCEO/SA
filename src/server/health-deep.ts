import "server-only";
import { timingSafeEqual } from "node:crypto";
import { and, eq, isNull, max, sql } from "drizzle-orm";
import { db } from "@/db";
import { appSettings, mailboxes } from "@/db/schema";
import type { EmailSender } from "@/lib/email";
import { notifyAdminOnce } from "./admin-notify";

/**
 * Check 1 P4: a health check that looks at the database and the background jobs, for a free
 * uptime monitor (`/api/health/deep`) and a Vercel Cron backstop (`/api/cron/jobs-check`) — both
 * work even when Inngest itself is down. Counts and minutes only, never an id.
 */

/** Written at the end of every 15-minute workspace-lifecycle run. */
export const LIFECYCLE_LAST_RUN_KEY = "jobs:workspace-lifecycle:last-run";
/** The lifecycle job runs every 15 minutes; two missed runs mean the jobs look stopped. */
export const JOBS_STALE_MINUTES = 30;

export async function recordLifecycleRun(now: Date = new Date()) {
  await db()
    .insert(appSettings)
    .values({ key: LIFECYCLE_LAST_RUN_KEY, value: now.toISOString(), updatedAt: now })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value: now.toISOString(), updatedAt: now },
    });
}

export type DeepHealth = {
  db: "ok";
  jobs: "ok" | "stale";
  minutesSinceJobs: number | null;
  minutesSinceMailCheck: number | null;
};

/** Throws when the database can't be reached (the route answers 503 then). */
export async function deepHealth(now: Date = new Date()): Promise<DeepHealth> {
  await db().execute(sql`select 1`);
  const [run] = await db()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, LIFECYCLE_LAST_RUN_KEY));
  const [sync] = await db()
    .select({ at: max(mailboxes.lastSyncedAt) })
    .from(mailboxes)
    .where(and(eq(mailboxes.status, "active"), isNull(mailboxes.planPausedAt)));
  const minutesSince = (d: Date | null | undefined) =>
    d && !Number.isNaN(d.getTime()) ? Math.floor((now.getTime() - d.getTime()) / 60_000) : null;
  const minutesSinceMailCheck = minutesSince(sync?.at ?? null);
  // Before the first recorded run (right after this ships), the 5-minute mail check — also an
  // Inngest job — stands in.
  const minutesSinceJobs = run ? minutesSince(new Date(run.value)) : minutesSinceMailCheck;
  return {
    db: "ok",
    jobs: minutesSinceJobs !== null && minutesSinceJobs <= JOBS_STALE_MINUTES ? "ok" : "stale",
    minutesSinceJobs,
    minutesSinceMailCheck,
  };
}

/** "Background jobs look stopped", to Davi, at most once per clock hour (UTC). */
export async function alertIfJobsStopped(
  health: DeepHealth,
  now: Date = new Date(),
  deps: { send?: EmailSender } = {},
): Promise<"sent" | "already" | "not_configured" | "no_admin" | "fine"> {
  if (health.jobs === "ok") return "fine";
  const hour = now.toISOString().slice(0, 13);
  return notifyAdminOnce(
    `jobs_stopped:${hour}`,
    {
      subject: "Background jobs look stopped",
      serif: "heads up,",
      heavy: "jobs look stopped.",
      lines: [
        health.minutesSinceJobs === null
          ? "The 15-minute safety job hasn't run yet."
          : `The 15-minute safety job last ran ${health.minutesSinceJobs} minutes ago.`,
        "Mail sorting, alerts and the morning email wait until it runs again. Open the Inngest dashboard (Vercel → sa → Integrations → Inngest) and look for failed runs.",
      ],
    },
    { send: deps.send, now },
  );
}

/** Constant-time check of a shared secret; an unset secret never matches. */
export function secretMatches(expected: string | undefined, received: string | null): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  return a.length === b.length && timingSafeEqual(a, b);
}
