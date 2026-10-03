import { RetryAfterError } from "inngest";
import { describe, expect, it } from "vitest";
import { afterSync, functions, politely } from "@/jobs/functions";
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

  it("registers every job with Inngest", () => {
    const ids = functions.map((f) => f.id());
    // Every job defined in the file must be registered, or it silently never runs.
    expect(ids.sort()).toEqual(
      [
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
        "purge-expired-bodies",
      ].sort(),
    );
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
