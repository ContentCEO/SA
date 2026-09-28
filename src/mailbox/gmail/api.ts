import "server-only";
import { z } from "zod";
import {
  HistoryExpiredError,
  MailboxAuthError,
  type HistoryPage,
  type MailboxReader,
  type MailMessage,
} from "../connector";
import { toMailMessage, type GmailMessageResource } from "./parse";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

type Fetch = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

export type GmailReaderOptions = {
  refreshToken: string;
  fetchImpl?: Fetch;
  sleep?: Sleep;
  /** Retries for 429/5xx before giving up. */
  maxRetries?: number;
  random?: () => number;
};

/** Gmail error reasons that mean "slow down", not "you did something wrong". */
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "backendError"]);

/** Exponential backoff with full jitter: random(0, base * 2^attempt), capped. */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  baseMs = 500,
  capMs = 30_000,
) {
  return Math.floor(random() * Math.min(capMs, baseMs * 2 ** attempt));
}

const tokenResponse = z.object({ access_token: z.string(), expires_in: z.number().optional() });

export function createGmailReader(opts: GmailReaderOptions): MailboxReader {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep: Sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 5;
  const random = opts.random ?? Math.random;
  let accessToken: string | undefined;

  async function refresh(): Promise<string> {
    const clientId = process.env.AUTH_GOOGLE_ID;
    const clientSecret = process.env.AUTH_GOOGLE_SECRET;
    if (!clientId || !clientSecret) throw new Error("Google OAuth client is not configured.");
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: opts.refreshToken,
          grant_type: "refresh_token",
        }),
      });
      if (res.ok) {
        accessToken = tokenResponse.parse(await res.json()).access_token;
        return accessToken;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // invalid_grant = revoked, expired, or password changed. unauthorized_client = client lost access.
      if (body.error === "invalid_grant" || body.error === "unauthorized_client") {
        throw new MailboxAuthError();
      }
      if (res.status >= 500 && attempt < maxRetries) {
        await sleep(backoffDelay(attempt, random));
        continue;
      }
      throw new Error(`Token refresh failed (${res.status}).`);
    }
  }

  /** GET/POST against the Gmail API with auth refresh and backoff. Returns null on 404. */
  async function call<T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T | null> {
    let refreshedAfter401 = false;
    for (let attempt = 0; ; attempt++) {
      const token = accessToken ?? (await refresh());
      const res = await fetchImpl(`${API}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init?.body ? { "content-type": "application/json" } : {}),
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
      if (res.ok) return (await res.json()) as T;
      if (res.status === 404) return null;
      if (res.status === 401) {
        if (refreshedAfter401) throw new MailboxAuthError();
        refreshedAfter401 = true;
        accessToken = undefined;
        continue;
      }
      const err = (await res.json().catch(() => ({}))) as {
        error?: { errors?: { reason?: string }[] };
      };
      const reason = err.error?.errors?.[0]?.reason;
      const retryable =
        res.status === 429 ||
        res.status >= 500 ||
        (res.status === 403 && RATE_LIMIT_REASONS.has(reason ?? ""));
      if (retryable && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : backoffDelay(attempt, random),
        );
        continue;
      }
      if (res.status === 403 && !retryable)
        throw new MailboxAuthError("Gmail access is not permitted.");
      throw new Error(`Gmail API ${res.status}${reason ? ` (${reason})` : ""}.`);
    }
  }

  return {
    async getProfile() {
      const p = await call<{ emailAddress: string; historyId: string }>("/profile");
      if (!p) throw new Error("Gmail profile not found.");
      return p;
    },

    async listMessages({ query, pageToken, maxResults = 100 }) {
      const qs = new URLSearchParams({ q: query, maxResults: String(maxResults) });
      if (pageToken) qs.set("pageToken", pageToken);
      const r = await call<{
        messages?: { id: string; threadId: string }[];
        nextPageToken?: string;
      }>(`/messages?${qs}`);
      return { messages: r?.messages ?? [], nextPageToken: r?.nextPageToken };
    },

    async getMessage(id, { withBody }): Promise<MailMessage | null> {
      const qs = new URLSearchParams({ format: withBody ? "full" : "metadata" });
      if (!withBody) {
        for (const h of [
          "From",
          "To",
          "Cc",
          "Subject",
          "Message-ID",
          "References",
          "In-Reply-To",
        ]) {
          qs.append("metadataHeaders", h);
        }
      }
      const r = await call<GmailMessageResource>(`/messages/${encodeURIComponent(id)}?${qs}`);
      return r ? toMailMessage(r, withBody) : null;
    },

    async listHistory({ startHistoryId, pageToken }): Promise<HistoryPage> {
      const qs = new URLSearchParams({ startHistoryId, historyTypes: "messageAdded" });
      if (pageToken) qs.set("pageToken", pageToken);
      const r = await call<{
        history?: { messagesAdded?: { message: { id: string; threadId: string } }[] }[];
        nextPageToken?: string;
        historyId: string;
      }>(`/history?${qs}`);
      if (!r) throw new HistoryExpiredError();
      const added = (r.history ?? []).flatMap((h) => (h.messagesAdded ?? []).map((m) => m.message));
      return { added, nextPageToken: r.nextPageToken, historyId: r.historyId };
    },

    async watch(topicName) {
      const r = await call<{ historyId: string; expiration: string }>("/watch", {
        method: "POST",
        body: { topicName, labelIds: ["INBOX"], labelFilterBehavior: "include" },
      });
      if (!r) throw new Error("Gmail watch failed.");
      return { historyId: r.historyId, expiration: Number(r.expiration) };
    },
  };
}
