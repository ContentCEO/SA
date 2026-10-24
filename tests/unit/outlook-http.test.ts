import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailboxAuthError, MailboxRateLimitError } from "@/mailbox/connector";
import { createGraphCaller, GraphRequestError, graphUrl } from "@/mailbox/outlook/http";

/** Plan #49: the one Microsoft Graph request path (tokens, rotation, backoff, ImmutableId). */

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const token = (rt?: string) => json({ access_token: "at", ...(rt ? { refresh_token: rt } : {}) });

beforeEach(() => {
  vi.stubEnv("FEATURE_OUTLOOK", "1");
  vi.stubEnv("MS_CLIENT_ID", "ms-id");
  vi.stubEnv("MS_CLIENT_SECRET", "ms-secret");
});
afterEach(() => vi.unstubAllEnvs());

function caller(
  f: ReturnType<typeof vi.fn>,
  extra: { onRotated?: (t: string) => Promise<void> } = {},
) {
  const sleep = vi.fn().mockResolvedValue(undefined);
  return {
    g: createGraphCaller({
      refreshToken: "rt-1",
      fetchImpl: f as unknown as typeof fetch,
      sleep,
      random: () => 0.5,
      onRefreshTokenRotated: extra.onRotated,
    }),
    sleep,
  };
}

describe("Graph requests", () => {
  it('every request says Prefer: IdType="ImmutableId" and carries the bearer token', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockImplementation(async () => json({ id: "x" }));
    const { g } = caller(f);
    await g.call("/me/messages/x");
    await g.call("/me/messages/y", { textBody: true });
    expect(f.mock.calls[1]![0]).toBe("https://graph.microsoft.com/v1.0/me/messages/x");
    expect(f.mock.calls[1]![1].headers.prefer).toBe('IdType="ImmutableId"');
    expect(f.mock.calls[1]![1].headers.authorization).toBe("Bearer at");
    expect(f.mock.calls[2]![1].headers.prefer).toBe(
      'IdType="ImmutableId", outlook.body-content-type="text"',
    );
    // One refresh for both.
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("refreshes with the Azure app's credentials and our scopes", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockImplementation(async () => json({}));
    await caller(f).g.call("/me");
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://login.microsoftonline.com/common/oauth2/v2.0/token");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("rt-1");
    expect(body.get("client_id")).toBe("ms-id");
    expect(body.get("scope")).toContain("Mail.Send");
  });

  it("keeps a rotated refresh token: stored through the hook, and used for the next refresh", async () => {
    const stored: string[] = [];
    const f = vi
      .fn()
      .mockResolvedValueOnce(token("rt-2"))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(token("rt-3"))
      .mockResolvedValueOnce(json({ ok: 1 }));
    await caller(f, { onRotated: async (t) => void stored.push(t) }).g.call("/me");
    expect(stored).toEqual(["rt-2", "rt-3"]);
    expect(new URLSearchParams(String(f.mock.calls[2]![1].body)).get("refresh_token")).toBe("rt-2");
  });

  it("a failed store is logged by name only and the new token is still used", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = vi.fn().mockResolvedValueOnce(token("rt-2")).mockResolvedValueOnce(json({}));
    await caller(f, {
      onRotated: async () => Promise.reject(new TypeError("db down rt-2")),
    }).g.call("/me");
    expect(err).toHaveBeenCalledWith("refresh_token_store_failed", { name: "TypeError" });
    expect(JSON.stringify(err.mock.calls)).not.toContain("rt-2");
    err.mockRestore();
  });

  it("re-refreshes once on 401, then gives up as lost access", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({}, 401));
    await expect(caller(f).g.call("/me")).rejects.toBeInstanceOf(MailboxAuthError);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it.each(["invalid_grant", "interaction_required", "unauthorized_client"])(
    "token error %s = the owner's grant is gone",
    async (error) => {
      const f = vi.fn().mockImplementation(async () => json({ error }, 400));
      await expect(caller(f).g.call("/me")).rejects.toBeInstanceOf(MailboxAuthError);
    },
  );

  it("invalid_client (our own secret) is a plain error, never 'reconnect'", async () => {
    const f = vi.fn().mockImplementation(async () => json({ error: "invalid_client" }, 401));
    const p = caller(f).g.call("/me");
    await expect(p).rejects.toBeInstanceOf(GraphRequestError);
    await expect(p).rejects.not.toBeInstanceOf(MailboxAuthError);
  });

  it("a permanent 403 is lost access", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({ error: { code: "ErrorAccessDenied" } }, 403));
    await expect(caller(f).g.call("/me")).rejects.toBeInstanceOf(MailboxAuthError);
  });

  it("429 with a short Retry-After waits that long and tries again", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        json({ error: { code: "TooManyRequests" } }, 429, { "retry-after": "3" }),
      )
      .mockResolvedValueOnce(json({ ok: 1 }));
    const { g, sleep } = caller(f);
    await expect(g.call("/me")).resolves.toEqual({ ok: 1 });
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it("a long Retry-After pauses the job instead (MailboxRateLimitError with the time)", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "600" }));
    const p = caller(f).g.call("/me");
    await expect(p).rejects.toBeInstanceOf(MailboxRateLimitError);
    await expect(p).rejects.toHaveProperty("retryAt");
  });

  it("429 after every retry → MailboxRateLimitError; 503 backs off with jitter", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockImplementation(async () => json({}, 429));
    const { g, sleep } = caller(f);
    await expect(g.call("/me")).rejects.toBeInstanceOf(MailboxRateLimitError);
    expect(sleep).toHaveBeenCalledTimes(5);
    const f2 = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ ok: 2 }));
    const c2 = caller(f2);
    await expect(c2.g.call("/me")).resolves.toEqual({ ok: 2 });
    expect(c2.sleep).toHaveBeenCalledWith(250);
  });

  it("404 → null, 202 → {} (a send), errors carry Graph's code but never its text", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({}, 404))
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(
        json({ error: { code: "ErrorInvalidIdMalformed", message: "Dana's secret" } }, 400),
      );
    const { g } = caller(f);
    expect(await g.call("/me/messages/x")).toBeNull();
    expect(await g.call("/me/messages/x/send", { method: "POST" })).toEqual({});
    const e = await g.call("/me/messages/y").catch((x: unknown) => x as GraphRequestError);
    expect(e).toBeInstanceOf(GraphRequestError);
    expect((e as GraphRequestError).code).toBe("ErrorInvalidIdMalformed");
    expect((e as Error).message).not.toContain("Dana");
  });

  it("follows Graph's own next/delta links, and refuses a link anywhere else", () => {
    expect(graphUrl("https://graph.microsoft.com/v1.0/me/messages?$skiptoken=1")).toBe(
      "https://graph.microsoft.com/v1.0/me/messages?$skiptoken=1",
    );
    expect(() => graphUrl("https://evil.example/v1.0/me")).toThrow(/off the Graph base/);
    expect(() => graphUrl("https://graph.microsoft.com.evil.example/v1.0/me")).toThrow();
  });
});
