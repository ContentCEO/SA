import "server-only";
import { gte, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobRuns } from "@/db/schema";

const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Check 25 P4: count one background job run or step (Inngest bills both). One atomic upsert;
 * never throws (a counting hiccup must not fail a job). Counts only.
 */
export async function countJobRun(functionId: string, kind: "run" | "step", now = new Date()) {
  try {
    await db()
      .insert(jobRuns)
      .values({
        functionId,
        day: utcDay(now),
        runs: kind === "run" ? 1 : 0,
        steps: kind === "step" ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: [jobRuns.functionId, jobRuns.day],
        set:
          kind === "run"
            ? { runs: sql`${jobRuns.runs} + 1` }
            : { steps: sql`${jobRuns.steps} + 1` },
      });
  } catch (err) {
    console.error("job_runs_count_failed", { error: (err as Error)?.name ?? "unknown" });
  }
}

/** For /admin: this UTC month's runs + steps (what Inngest meters as executions). */
export async function jobExecutionsThisMonth(now = new Date()): Promise<number> {
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const [row] = await db()
    .select({ n: sql<number>`coalesce(sum(${jobRuns.runs} + ${jobRuns.steps}), 0)::int` })
    .from(jobRuns)
    .where(gte(jobRuns.day, monthStart));
  return Number(row?.n ?? 0);
}

/** Daily cleanup: keep about four months of counts. */
export async function purgeJobRuns(now = new Date()) {
  await db()
    .delete(jobRuns)
    .where(lt(jobRuns.day, utcDay(new Date(now.getTime() - 120 * 86_400_000))));
}
