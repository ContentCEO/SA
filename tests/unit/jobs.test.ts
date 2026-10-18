import { readFileSync } from "node:fs";
import { RetryAfterError } from "inngest";
import { describe, expect, it } from "vitest";
import {
  afterSync,
  functions,
  politely,
  reportSummaryFailures,
  SummaryFailuresError,
} from "@/jobs/functions";
import { MailboxAuthError, MailboxRateLimitError } from "@/mailbox/connector";

describe("job wiring", () => {
  it("sorts new mail after a sync; with none, reconciles only when a draft or send is pending (Check 25 P4)", () => {
    expect(afterSync("m1", 3)!.name).toBe("mailbox/classify.requested");
    expect(afterSync("m1", 0)).toBeNull();
    expect(afterSync("m1", 0, false)).toBeNull();
    expect(afterSync("m1", 0, true)!.name).toBe("mailbox/draft.requested");
    expect(afterSync("m1", 0, true)!.data).toEqual({ mailboxId: "m1" });
  });

  it("Gmail rate limits pause the step for a couple of minutes instead of failing it", async () => {
    const err = await politely(async () => {
      throw new MailboxRateLimitError();
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RetryAfterError);
    expect((err as RetryAfterError).retryAfter).toBeTruthy();
    // Gmail's own cool-down wins when it's longer than our default pause.
    const later = new Date(Date.now() + 30 * 60_000);
    const waited = (await politely(async () => {
      throw new MailboxRateLimitError("slow down", later);
    }).catch((e: unknown) => e)) as RetryAfterError;
    expect(new Date(waited.retryAfter).getTime()).toBe(later.getTime() + 60_000);
    // Anything else passes through untouched.
    await expect(
      politely(async () => {
        throw new MailboxAuthError();
      }),
    ).rejects.toBeInstanceOf(MailboxAuthError);
    await expect(politely(async () => 7)).resolves.toBe(7);
  });

  it("a failed morning or monthly summary still fails the run (so it reaches error alerts), counts only", () => {
    expect(() => reportSummaryFailures({ failed: 0 }, { failed: 0 })).not.toThrow();
    for (const [d, m] of [
      [1, 0],
      [0, 2],
    ] as const) {
      let err: unknown;
      try {
        reportSummaryFailures({ failed: d }, { failed: m });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SummaryFailuresError);
      expect((err as Error).name).toBe("SummaryFailuresError");
      expect((err as Error).message).toBe(`Summaries failed: ${d} morning, ${m} monthly.`);
    }
    // It runs after both steps, so a morning failure can't stop the monthly step.
    const src = readFileSync("src/jobs/functions.ts", "utf8");
    const body = src.slice(src.indexOf('id: "morning-digest"'));
    const report = body.indexOf("reportSummaryFailures(digests, monthly)");
    expect(report).toBeGreaterThan(body.indexOf('step.run("monthly"'));
    expect(body.indexOf('step.run("monthly"')).toBeGreaterThan(body.indexOf('step.run("send"'));
  });

  it("registers every job with Inngest", () => {
    const ids = functions.map((f) => f.id());
    // Every job defined in the file must be registered, or it silently never runs.
    expect(ids.sort()).toEqual(
      [
        "autopilot-send",
        "backfill-mailbox",
        "sync-mailbox",
        "workspace-lifecycle",
        "classify-mailbox",
        "draft-mailbox",
        "followup-scan",
        "learn-voice",
        "morning-digest",
        "refresh-voices",
        "poll-mailboxes",
        "renew-gmail-watches",
        "reply-to-backfill",
        "purge-expired-bodies",
        "send-after-undo",
        "voice-ideas",
        "found-money-drafts",
      ].sort(),
    );
  });
});

describe("the 15-minute workspace-lifecycle job", () => {
  const lifecycleBody = () => {
    const src = readFileSync("src/jobs/functions.ts", "utf8");
    const head = "export const workspaceLifecycle = inngest.createFunction(";
    const start = src.indexOf(head);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("inngest.createFunction(", start + head.length);
    return src.slice(start, next === -1 ? undefined : next);
  };

  it("runs the lead-at-risk pushes (plan #34), after the new-lead pushes and the M7 backfill (A29)", () => {
    const body = lifecycleBody();
    const atRisk = body.indexOf('"lead-at-risk-pushes": () => sendLeadAtRiskPushes()');
    expect(atRisk).toBeGreaterThan(-1);
    const backfill = body.indexOf('"m7-backfill": () => runM7Backfill()');
    const pushes = body.indexOf('"push-alerts": () => sendPushAlerts()');
    expect(backfill).toBeGreaterThan(-1);
    expect(pushes).toBeGreaterThan(-1);
    expect(atRisk).toBeGreaterThan(backfill);
    expect(atRisk).toBeGreaterThan(pushes);
  });
});

describe("no job is left unregistered", () => {
  it("registers every createFunction in the jobs file", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/jobs/functions.ts", "utf8");
    const defined = [...src.matchAll(/export const (\w+) = inngest\.createFunction/g)].map(
      (m) => m[1],
    );
    const mod = await import("@/jobs/functions");
    for (const name of defined) {
      expect(mod.functions).toContain((mod as Record<string, unknown>)[name!]);
    }
  });
});

describe("background executions (Check 25 P4)", () => {
  it("workspace-lifecycle has at most 4 steps, and every check inside is wrapped on its own", async () => {
    const src = readFileSync("src/jobs/functions.ts", "utf8");
    const head = "export const workspaceLifecycle = inngest.createFunction(";
    const start = src.indexOf(head);
    const next = src.indexOf("inngest.createFunction(", start + head.length);
    const body = src.slice(start, next === -1 ? undefined : next);
    const steps = [...body.matchAll(/step\.run\(/g)];
    expect(steps.length).toBeLessThanOrEqual(4);
    // Each step.run hands its checks to runChecks (one try/catch per check).
    const wrapped = [...body.matchAll(/step\.run\("[^"]+", \(\) =>\s*runChecks\(\{/g)];
    expect(wrapped.length).toBe(steps.length);
    // Every check from before is still there.
    for (const name of [
      "startPendingEvaluations",
      "expireEvaluations",
      "fitAllMailboxesToPlans",
      "overdueAutopilotDrafts",
      "overdueQueuedSends",
      "unsortedSweepMailboxes",
      "workspacesNeedingVoice",
      "sendAccessLostAlerts",
      "sendEmergencyAlerts",
      "sendLeadAlerts",
      "sendPushAlerts",
      "runM7Backfill",
      "runDraftMessagesCleanup",
      "sendLeadAtRiskPushes",
      "applyPendingReferralCredits",
      "sendFirstDraftsReady",
      "sendTrialEmails",
    ])
      expect(body, name).toContain(`${name}()`);
  });

  it("runChecks keeps going after a failure, reports it, and says which failed", async () => {
    const { runChecks } = await import("@/jobs/functions");
    const order: string[] = [];
    const r = await runChecks({
      a: async () => {
        order.push("a");
        return 1;
      },
      b: async () => {
        order.push("b");
        throw new Error("boom");
      },
      c: async () => {
        order.push("c");
        return "ok";
      },
    });
    expect(order).toEqual(["a", "b", "c"]);
    expect(r.failed).toEqual(["b"]);
    expect(r.results).toEqual({ a: 1, c: "ok" });
  });

  it("the poll leaves a mailbox to Gmail push while its watch is live and it synced lately", async () => {
    const { pollDue } = await import("@/server/sync");
    const now = new Date("2026-10-17T12:00:00Z");
    const live = new Date("2026-10-20T00:00:00Z");
    const ago = (min: number) => new Date(now.getTime() - min * 60_000);
    // Without a Pub/Sub topic every mailbox is polled.
    expect(pollDue({ watchExpiresAt: live, lastSyncedAt: ago(1) }, now, false)).toBe(true);
    expect(pollDue({ watchExpiresAt: live, lastSyncedAt: ago(5) }, now, true)).toBe(false);
    expect(pollDue({ watchExpiresAt: live, lastSyncedAt: ago(16) }, now, true)).toBe(true);
    expect(pollDue({ watchExpiresAt: ago(1), lastSyncedAt: ago(1) }, now, true)).toBe(true);
    expect(pollDue({ watchExpiresAt: null, lastSyncedAt: ago(1) }, now, true)).toBe(true);
    expect(pollDue({ watchExpiresAt: live, lastSyncedAt: null }, now, true)).toBe(true);
  });

  it("the Reply-To backfill wakes daily, and only chains a 15-minute rerun while unfinished", () => {
    const src = readFileSync("src/jobs/functions.ts", "utf8");
    const body = src.slice(src.indexOf('id: "reply-to-backfill"'));
    expect(body).toMatch(/triggers: \[cron\("43 4 \* \* \*"\), replyToBackfillContinue\]/);
    expect(body.indexOf("if (!done)")).toBeLessThan(body.indexOf('"continue"'));
  });
});

describe("no run can pass Inngest's 1,000 steps (Check 25 P3 / P5)", () => {
  it("the first read and a history re-read are capped per run", async () => {
    const { MAX_BACKFILL_PAGES_PER_RUN, MAX_RESYNC_PAGES_PER_RUN } = await import("@/server/sync");
    expect(MAX_BACKFILL_PAGES_PER_RUN + 10).toBeLessThan(1_000);
    expect(MAX_RESYNC_PAGES_PER_RUN + 10).toBeLessThan(1_000);
    const src = readFileSync("src/jobs/functions.ts", "utf8");
    const backfill = src.slice(
      src.indexOf('id: "backfill-mailbox"'),
      src.indexOf('id: "sync-mailbox"'),
    );
    expect(backfill).toContain("page < MAX_BACKFILL_PAGES_PER_RUN");
    const sync = src.slice(
      src.indexOf('id: "sync-mailbox"'),
      src.indexOf('id: "classify-mailbox"'),
    );
    expect(sync).toContain("page < MAX_RESYNC_PAGES_PER_RUN");
  });
});
