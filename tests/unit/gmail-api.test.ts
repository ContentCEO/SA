import { beforeEach, describe, expect, it, vi } from "vitest";
import { HistoryExpiredError, MailboxAuthError, MailboxRateLimitError } from "@/mailbox/connector";
import { backoffDelay, createGmailReader, parseRetryAfter } from "@/mailbox/gmail/api";
import { extractBodyText, htmlToText, parseAddressList } from "@/mailbox/gmail/parse";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
const token = () => json({ access_token: "at", expires_in: 3600 });
const b64 = (s: string) => Buffer.from(s).toString("base64url");

beforeEach(() => {
  process.env.AUTH_GOOGLE_ID = "id";
  process.env.AUTH_GOOGLE_SECRET = "secret";
});

function reader(fetchMock: ReturnType<typeof vi.fn>, sleep = vi.fn().mockResolvedValue(undefined)) {
  return {
    r: createGmailReader({
      refreshToken: "rt",
      fetchImpl: fetchMock as unknown as typeof fetch,
      sleep,
      random: () => 0.5,
    }),
    sleep,
  };
}

describe("token refresh and revocation", () => {
  it("refreshes once and reuses the access token", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({ emailAddress: "o@x.com", historyId: "5" }))
      .mockResolvedValueOnce(json({ emailAddress: "o@x.com", historyId: "6" }));
    const { r } = reader(f);
    await r.getProfile();
    await r.getProfile();
    expect(f).toHaveBeenCalledTimes(3);
    expect(String(f.mock.calls[1]![1].headers.authorization)).toBe("Bearer at");
  });

  it("treats invalid_grant as revoked access", async () => {
    const f = vi.fn().mockResolvedValue(json({ error: "invalid_grant" }, 400));
    await expect(reader(f).r.getProfile()).rejects.toBeInstanceOf(MailboxAuthError);
  });

  it("re-refreshes once on 401, then gives up as revoked", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({}, 401));
    await expect(reader(f).r.getProfile()).rejects.toBeInstanceOf(MailboxAuthError);
    expect(f).toHaveBeenCalledTimes(4);
  });

  it("treats a permanent 403 (scope removed) as lost access", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        json({ error: { errors: [{ reason: "insufficientPermissions" }] } }, 403),
      );
    await expect(reader(f).r.getProfile()).rejects.toBeInstanceOf(MailboxAuthError);
  });
});

describe("rate limits", () => {
  it("backs off with jitter on 429 and 5xx, honoring Retry-After", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "2" }))
      .mockResolvedValueOnce(
        json({ error: { errors: [{ reason: "userRateLimitExceeded" }] } }, 403),
      )
      .mockResolvedValueOnce(json({}, 503))
      .mockResolvedValueOnce(json({ emailAddress: "o@x.com", historyId: "5" }));
    const { r, sleep } = reader(f);
    await expect(r.getProfile()).resolves.toMatchObject({ historyId: "5" });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([
      2000,
      backoffDelay(1, () => 0.5),
      backoffDelay(2, () => 0.5),
    ]);
  });

  it("stops after the retry budget", async () => {
    const f = vi.fn().mockResolvedValueOnce(token()).mockResolvedValue(json({}, 500));
    const r = createGmailReader({
      refreshToken: "rt",
      fetchImpl: f,
      sleep: async () => {},
      maxRetries: 2,
    });
    await expect(r.getProfile()).rejects.toThrow(/500/);
    expect(f).toHaveBeenCalledTimes(4); // token + 3 tries
  });

  it("a rate limit that outlasts the retries is reported as 'slow down', not a failure", async () => {
    const limited = () => json({ error: { errors: [{ reason: "rateLimitExceeded" }] } }, 403);
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockImplementation(async () => limited());
    const r = createGmailReader({
      refreshToken: "rt",
      fetchImpl: f,
      sleep: async () => {},
      maxRetries: 2,
    });
    const err = await r.getProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailboxRateLimitError);
    expect(err).not.toBeInstanceOf(MailboxAuthError);
  });

  it("when Gmail names a cool-down time, stops at once and reports it (retrying only extends it)", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValue(
        json(
          {
            error: {
              message: "User-rate limit exceeded.  Retry after 2026-10-03T14:45:00.000Z",
              errors: [{ reason: "rateLimitExceeded" }],
            },
          },
          403,
        ),
      );
    const { r, sleep } = reader(f);
    const err = await r.getProfile().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailboxRateLimitError);
    expect((err as MailboxRateLimitError).retryAt).toEqual(new Date("2026-10-03T14:45:00.000Z"));
    expect(sleep).not.toHaveBeenCalled();
    expect(f).toHaveBeenCalledTimes(2); // token + one try
  });

  it("parses Gmail's retry-after text, and ignores anything else", () => {
    expect(parseRetryAfter("User-rate limit exceeded. Retry after 2026-10-03T14:45:00Z")).toEqual(
      new Date("2026-10-03T14:45:00Z"),
    );
    expect(parseRetryAfter("Rate Limit Exceeded")).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it("keeps jittered delays within the exponential cap", () => {
    for (let a = 0; a < 10; a++) {
      expect(backoffDelay(a, () => 0.999)).toBeLessThanOrEqual(Math.min(30_000, 500 * 2 ** a));
      expect(backoffDelay(a, () => 0)).toBe(0);
    }
  });
});

describe("history", () => {
  it("maps a 404 to an expired cursor", async () => {
    const f = vi.fn().mockResolvedValueOnce(token()).mockResolvedValueOnce(json({}, 404));
    await expect(reader(f).r.listHistory({ startHistoryId: "1" })).rejects.toBeInstanceOf(
      HistoryExpiredError,
    );
  });

  it("flattens added messages", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(
        json({
          historyId: "9",
          history: [{ messagesAdded: [{ message: { id: "a", threadId: "t" } }] }, {}],
        }),
      );
    await expect(reader(f).r.listHistory({ startHistoryId: "1" })).resolves.toEqual({
      added: [{ id: "a", threadId: "t" }],
      historyId: "9",
      nextPageToken: undefined,
    });
  });

  it("asks for metadata only unless a body is needed", async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(token())
      .mockResolvedValueOnce(json({ id: "m", threadId: "t", payload: { headers: [] } }));
    await reader(f).r.getMessage("m", { withBody: false });
    const url = String(f.mock.calls[1]![0]);
    expect(url).toContain("format=metadata");
    expect(url).not.toContain("format=full");
  });
});

describe("message parsing", () => {
  it("prefers text/plain inside multipart", () => {
    const text = extractBodyText({
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64("Need a panel upgrade quote.") } },
        { mimeType: "text/html", body: { data: b64("<p>ignored</p>") } },
      ],
    });
    expect(text).toBe("Need a panel upgrade quote.");
  });

  it("falls back to html → text and skips attachments", () => {
    const text = extractBodyText({
      mimeType: "multipart/mixed",
      parts: [
        { mimeType: "text/plain", filename: "notes.txt", body: { data: b64("attachment") } },
        {
          mimeType: "text/html",
          body: { data: b64("<div>Hi<br>Can you come <b>Tuesday</b>?</div><style>x{}</style>") },
        },
      ],
    });
    expect(text).toBe("Hi\nCan you come Tuesday?");
  });

  it("strips scripts and entities", () => {
    expect(htmlToText("<script>alert(1)</script>A &amp; B")).toBe("A & B");
  });

  it("parses address lists with names and quotes", () => {
    expect(parseAddressList('"Ruiz, Dana" <Dana@Example.com>, bob@x.com')).toEqual([
      { name: "Ruiz, Dana", email: "dana@example.com" },
      { email: "bob@x.com" },
    ]);
  });
});
