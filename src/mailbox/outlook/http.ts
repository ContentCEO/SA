import "server-only";
import { z } from "zod";
import { MailboxAuthError, MailboxRateLimitError } from "../connector";
import { backoffDelay } from "../gmail/api";
import { microsoftEndpoints } from "@/config/e2e";
import { outlookClientCredentials } from "@/config/outlook";
import { REQUIRED_OUTLOOK_SCOPES } from "./scopes";

/**
 * Plan #49: every Microsoft Graph request, in one place (plain `fetch`, no SDK — like the Gmail
 * client). It owns the access token: a refresh on first use, a second refresh once after a 401
 * and then `MailboxAuthError`; 429 / 503 / 504 retried with Retry-After or full-jitter backoff,
 * then `MailboxRateLimitError`. Every request carries `Prefer: IdType="ImmutableId"`, so a
 * message keeps one id when it moves folders and when a sent draft becomes the copy in Sent
 * Items (learn.microsoft.com/graph/outlook-immutable-id).
 *
 * Errors carry only the status and Graph's error code, never Graph's message text.
 */

type Fetch = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

export const IMMUTABLE_ID = 'IdType="ImmutableId"';
/** Bodies as plain text (Graph converts HTML mail): the same text Gmail's text/plain part gives. */
export const TEXT_BODY = 'outlook.body-content-type="text"';

/** A Retry-After longer than this isn't slept through inside the call: the job pauses instead. */
const MAX_INLINE_RETRY_AFTER_S = 60;

export type GraphOptions = {
  refreshToken: string;
  fetchImpl?: Fetch;
  sleep?: Sleep;
  maxRetries?: number;
  random?: () => number;
  /**
   * Microsoft hands out a new refresh token on every refresh and says to keep the new one and
   * drop the old (learn.microsoft.com/entra/identity-platform/refresh-tokens). Awaited; a failed
   * store is logged by name only, and this client keeps using the new token.
   */
  onRefreshTokenRotated?: (token: string) => Promise<void>;
};

/** A Graph answer we don't handle as a value: status and Graph's error code only. */
export class GraphRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string | undefined,
  ) {
    super(`Microsoft Graph ${status}${code ? ` (${code})` : ""}.`);
    this.name = "GraphRequestError";
  }
}

const tokenResponse = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
});

/** Token errors that mean the owner's grant is gone (revoked, expired, password reset, MFA). */
const GRANT_GONE = new Set(["invalid_grant", "interaction_required", "unauthorized_client"]);

const RETRYABLE = new Set([429, 503, 504]);

export type GraphInit = {
  method?: string;
  /** JSON body. */
  json?: unknown;
  /** A raw body with its content type (base64 MIME is sent as text/plain). */
  raw?: { body: string; contentType: string };
  /** Ask for message bodies as plain text. */
  textBody?: boolean;
  /** Extra preferences, e.g. odata.maxpagesize. */
  prefer?: string[];
};

export type GraphCaller = {
  /**
   * A Graph request. `path` is relative to the Graph base, or a full nextLink / deltaLink Graph
   * gave us (accepted only when it is on the same Graph base, so the bearer token never goes
   * anywhere else). Returns null on 404, `{}` on 202 / 204.
   */
  call<T>(path: string, init?: GraphInit): Promise<T | null>;
};

export function graphBase(): string {
  return microsoftEndpoints().graph;
}

/** Resolve a path or a Graph-issued link; anything off the Graph base is refused. */
export function graphUrl(pathOrLink: string): string {
  const base = graphBase();
  if (/^https?:\/\//i.test(pathOrLink)) {
    if (!pathOrLink.startsWith(`${base}/`)) throw new Error("Refusing a link off the Graph base.");
    return pathOrLink;
  }
  return `${base}${pathOrLink.startsWith("/") ? "" : "/"}${pathOrLink}`;
}

export function createGraphCaller(opts: GraphOptions): GraphCaller {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep: Sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 5;
  const random = opts.random ?? Math.random;
  let accessToken: string | undefined;
  let refreshToken = opts.refreshToken;

  /**
   * One refresh at a time: Microsoft rotates the refresh token on every refresh, so two
   * parallel refreshes would race and the second would present an already-replaced token.
   */
  let refreshing: Promise<string> | undefined;
  function refresh(): Promise<string> {
    refreshing ??= doRefresh().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  async function doRefresh(): Promise<string> {
    const creds = outlookClientCredentials();
    if (!creds) throw new Error("Outlook is not switched on (FEATURE_OUTLOOK / MS_CLIENT_ID).");
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(microsoftEndpoints().token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: creds.clientId,
          client_secret: creds.clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
          scope: REQUIRED_OUTLOOK_SCOPES.join(" "),
        }),
      });
      if (res.ok) {
        const answer = tokenResponse.parse(await res.json());
        accessToken = answer.access_token;
        if (answer.refresh_token && answer.refresh_token !== refreshToken) {
          refreshToken = answer.refresh_token;
          if (opts.onRefreshTokenRotated)
            await opts.onRefreshTokenRotated(answer.refresh_token).catch((e: unknown) => {
              console.error("refresh_token_store_failed", { name: (e as Error)?.name });
            });
        }
        return accessToken;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (GRANT_GONE.has(body.error ?? "")) throw new MailboxAuthError();
      // invalid_client = OUR secret expired or is wrong: not the owner's doing, so no mailbox
      // is marked "reconnect"; a plain error reaches Sentry instead.
      if ((res.status >= 500 || res.status === 429) && attempt < maxRetries) {
        await sleep(backoffDelay(attempt, random));
        continue;
      }
      throw new GraphRequestError(res.status, body.error);
    }
  }

  async function call<T>(path: string, init: GraphInit = {}): Promise<T | null> {
    const url = graphUrl(path);
    let refreshedAfter401 = false;
    for (let attempt = 0; ; attempt++) {
      const token = accessToken ?? (await refresh());
      const prefer = [IMMUTABLE_ID, ...(init.textBody ? [TEXT_BODY] : []), ...(init.prefer ?? [])];
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        prefer: prefer.join(", "),
      };
      let body: string | undefined;
      if (init.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(init.json);
      } else if (init.raw) {
        headers["content-type"] = init.raw.contentType;
        body = init.raw.body;
      }
      const res = await fetchImpl(url, { method: init.method ?? "GET", headers, body });
      if (res.status === 202 || res.status === 204) return {} as T;
      if (res.ok) return (await res.json()) as T;
      if (res.status === 404) return null;
      if (res.status === 401) {
        if (refreshedAfter401) throw new MailboxAuthError();
        refreshedAfter401 = true;
        // Only drop the token this request used: a parallel request may have refreshed already.
        if (accessToken === token) accessToken = undefined;
        continue;
      }
      const err = (await res.json().catch(() => ({}))) as { error?: { code?: string } };
      const code = err.error?.code;
      if (RETRYABLE.has(res.status)) {
        const after = Number(res.headers.get("retry-after"));
        const hasAfter = Number.isFinite(after) && after > 0;
        if (hasAfter && after > MAX_INLINE_RETRY_AFTER_S)
          throw new MailboxRateLimitError(
            `Microsoft Graph ${res.status}: slow down.`,
            new Date(Date.now() + after * 1000),
          );
        if (attempt < maxRetries) {
          await sleep(hasAfter ? after * 1000 : backoffDelay(attempt, random));
          continue;
        }
        if (res.status === 429) throw new MailboxRateLimitError("Microsoft Graph 429: slow down.");
        throw new GraphRequestError(res.status, code);
      }
      if (res.status >= 500 && attempt < maxRetries) {
        await sleep(backoffDelay(attempt, random));
        continue;
      }
      // A permanent 403: the permission was taken away, or the mailbox is off for the app.
      if (res.status === 403) throw new MailboxAuthError("Outlook access is not permitted.");
      throw new GraphRequestError(res.status, code);
    }
  }

  return { call };
}
