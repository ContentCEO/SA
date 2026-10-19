import { describe, expect, it } from "vitest";
import { createGmailConnector, REVOKE_TIMEOUT_MS } from "@/mailbox/gmail/connector";

/**
 * Found while hardening e2e (2026-10-19): Google's revoke had no time limit, so a hung request
 * left Disconnect on "Disconnecting…" forever. Disconnect and Delete my account already carry on
 * when revoke fails; a timeout now makes a hang one of those failures.
 */
describe("Google token revoke", () => {
  it("gives up after its time limit instead of hanging", async () => {
    let aborted = false;
    const hangs = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal!.reason);
        });
      })) as typeof fetch;
    const started = Date.now();
    await expect(
      createGmailConnector(hangs, { revokeTimeoutMs: 50 }).revoke("token"),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("still treats an already-revoked token (400) as done, and passes a signal", async () => {
    let signal: AbortSignal | null | undefined;
    const answered400 = (async (_url: string, init?: RequestInit) => {
      signal = init?.signal;
      return new Response("{}", { status: 400 });
    }) as typeof fetch;
    await expect(createGmailConnector(answered400).revoke("token")).resolves.toBeUndefined();
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(REVOKE_TIMEOUT_MS).toBe(10_000);
  });
});
