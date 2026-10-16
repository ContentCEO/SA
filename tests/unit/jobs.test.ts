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
  it("sorts new mail after a sync, and reconciles drafts when there's none", () => {
    expect(afterSync("m1", 3).name).toBe("mailbox/classify.requested");
    expect(afterSync("m1", 0).name).toBe("mailbox/draft.requested");
    expect(afterSync("m1", 0).data).toEqual({ mailboxId: "m1" });
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
  it("runs the lead-at-risk pushes (plan #34), after the new-lead pushes and the M7 backfill (A29)", () => {
    const src = readFileSync("src/jobs/functions.ts", "utf8");
    const head = "export const workspaceLifecycle = inngest.createFunction(";
    const start = src.indexOf(head);
    expect(start).toBeGreaterThan(-1);
    const next = src.indexOf("inngest.createFunction(", start + head.length);
    const body = src.slice(start, next === -1 ? undefined : next);
    const atRisk = body.indexOf('step.run("lead-at-risk-pushes", () => sendLeadAtRiskPushes())');
    expect(atRisk).toBeGreaterThan(-1);
    const backfill = body.indexOf('step.run("m7-backfill"');
    const pushes = body.indexOf('step.run("push-alerts"');
    expect(backfill).toBeGreaterThan(-1);
    expect(pushes).toBeGreaterThan(-1);
    expect(atRisk).toBeGreaterThan(backfill);
    expect(atRisk).toBeGreaterThan(pushes);
  });
});

describe("plan #47: the autopilot invariant runs every 15 minutes", () => {
  it("has its own step in the workspace-lifecycle job", () => {
    const src = readFileSync("src/jobs/functions.ts", "utf8");
    const head = "export const workspaceLifecycle = inngest.createFunction(";
    const start = src.indexOf(head);
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("inngest.createFunction(", start + head.length));
    expect(body).toContain('step.run("enforce-plan-autopilot", () => enforcePlanAutopilot())');
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
