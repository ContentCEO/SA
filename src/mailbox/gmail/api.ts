import "server-only";
import { z } from "zod";
import {
  HistoryExpiredError,
  InvalidPageTokenError,
  MailboxAuthError,
  MailboxRateLimitError,
  type HistoryPage,
  type MailboxReader,
  type MailboxWriter,
  type MailMessage,
} from "../connector";
import { googleEndpoints } from "@/config/e2e";
import { extractBodyText, toMailMessage, type GmailMessageResource } from "./parse";
import { GMAIL_UNITS, type GmailBudget, type GmailMethod } from "./quota";

type Fetch = typeof fetch;
type Sleep = (ms: number) => Promise<void>;

export type GmailReaderOptions = {
  refreshToken: string;
  fetchImpl?: Fetch;
  sleep?: Sleep;
  /** Retries for 429/5xx before giving up. */
  maxRetries?: number;
  random?: () => number;
  /**
   * The mailbox's shared unit budget (Check 25 P1). With it, every request reserves its
   * units first and a spent minute stops the call before any fetch. Tests may leave it out.
   */
  mailboxId?: string;
  budget?: GmailBudget;
  /**
   * Check 47 P2: Google answered a refresh with a different refresh token. Awaited; a failure
   * to store it is logged by name only and the new token is used for this client anyway.
   */
  onRefreshTokenRotated?: (token: string) => Promise<void>;
};

/** Gmail error reasons that mean "slow down", not "you did something wrong". */
/** Headers a metadata read asks for by default. Reply-To: website forms put the customer there. */
export const DEFAULT_METADATA_HEADERS = [
  "From",
  "To",
  "Cc",
  "Subject",
  "Message-ID",
  "References",
  "In-Reply-To",
  "Reply-To",
  // Check 20 P4 / 21 P1: automatic replies (RFC 3834). Only a true/false is kept.
  "Auto-Submitted",
  "X-Autoreply",
  "X-Autorespond",
  "Precedence",
  "X-Auto-Response-Suppress",
] as const;

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

/** "…Retry after 2026-10-03T14:45:00.000Z" → that time. */
export function parseRetryAfter(message: string | undefined): Date | undefined {
  const m = message?.match(/retry after (\d{4}-\d{2}-\d{2}T[\d:.]+Z)/i);
  if (!m) return undefined;
  const d = new Date(m[1]!);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

const tokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
});

export type GmailClient = MailboxReader & MailboxWriter & { gmailUnits(): number };

/**
 * Check 47 P4: Gmail's search words for a listing, built only here. `after:` takes epoch
 * seconds; `in:inbox` / `-in:inbox` split a window into inbox and the rest.
 */
export function gmailQuery(o: {
  newerThanDays?: number;
  after?: Date;
  inbox?: boolean;
  sentOnly?: boolean;
}): string {
  return [
    o.sentOnly ? "in:sent" : null,
    o.inbox === true ? "in:inbox" : o.inbox === false ? "-in:inbox" : null,
    o.after
      ? `after:${Math.floor(o.after.getTime() / 1000)}`
      : o.newerThanDays !== undefined
        ? `newer_than:${o.newerThanDays}d`
        : null,
  ]
    .filter(Boolean)
    .join(" ");
}

export function createGmailReader(opts: GmailReaderOptions): GmailClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep: Sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxRetries = opts.maxRetries ?? 5;
  const random = opts.random ?? Math.random;
  let accessToken: string | undefined;
  let refreshToken = opts.refreshToken;
  let unitsUsed = 0;

  /** Units are counted per request Google sees, retries included. */
  async function reserve(method: GmailMethod) {
    if (opts.budget) await opts.budget.reserve(method);
    unitsUsed += GMAIL_UNITS[method];
  }

  async function refresh(): Promise<string> {
    const clientId = process.env.AUTH_GOOGLE_ID;
    const clientSecret = process.env.AUTH_GOOGLE_SECRET;
    if (!clientId || !clientSecret) throw new Error("Google OAuth client is not configured.");
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(googleEndpoints().token, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
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
    unit: GmailMethod,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T | null> {
    let refreshedAfter401 = false;
    for (let attempt = 0; ; attempt++) {
      await reserve(unit);
      const token = accessToken ?? (await refresh());
      const res = await fetchImpl(`${googleEndpoints().gmailApi}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          authorization: `Bearer ${token}`,
          ...(init?.body ? { "content-type": "application/json" } : {}),
        },
        body: init?.body ? JSON.stringify(init.body) : undefined,
      });
      if (res.status === 204) return {} as T;
      if (res.ok) return (await res.json()) as T;
      if (res.status === 404) return null;
      if (res.status === 401) {
        if (refreshedAfter401) throw new MailboxAuthError();
        refreshedAfter401 = true;
        accessToken = undefined;
        continue;
      }
      const err = (await res.json().catch(() => ({}))) as {
        error?: { message?: string; errors?: { reason?: string }[] };
      };
      const reason = err.error?.errors?.[0]?.reason;
      // Gmail's own text, e.g. "User-rate limit exceeded. Retry after 2026-10-03T14:45:00.000Z".
      // Never contains mail content; safe to keep for diagnosis.
      const googleMessage = err.error?.message?.slice(0, 200);
      const retryAt = parseRetryAfter(googleMessage);
      const retryable =
        res.status === 429 ||
        res.status >= 500 ||
        (res.status === 403 && RATE_LIMIT_REASONS.has(reason ?? ""));
      // Gmail gave a cool-down time: retrying before it only extends it.
      if (retryable && retryAt) {
        // Shared with every other job for this inbox, so they all wait together.
        if (opts.budget)
          await opts.budget.coolUntil(retryAt).catch((e: unknown) => {
            console.error("gmail_cool_store_failed", { name: (e as Error)?.name });
          });
        throw new MailboxRateLimitError(
          `Gmail API ${res.status} (${reason ?? "rate limited"}): ${googleMessage}`,
          retryAt,
        );
      }
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
      if (res.status === 429 || (res.status === 403 && retryable))
        throw new MailboxRateLimitError(
          `Gmail API ${res.status}${reason ? ` (${reason})` : ""}${googleMessage ? `: ${googleMessage}` : "."}`,
        );
      throw new Error(`Gmail API ${res.status}${reason ? ` (${reason})` : ""}.`);
    }
  }

  async function threadMessageLabels(threadId: string) {
    // format=minimal still carries each message's snippet (body text), so the `fields` mask
    // asks Google for message ids and labels only: no headers, snippet or text reach us.
    const r = await call<{ messages?: { id: string; labelIds?: string[] }[] }>(
      "threads.get",
      `/threads/${encodeURIComponent(threadId)}?format=minimal&fields=${encodeURIComponent("messages(id,labelIds)")}`,
    );
    return (r?.messages ?? []).map((m) => ({ id: m.id, labelIds: m.labelIds ?? [] }));
  }

  return {
    /** Units this client has used (for the content-free per-run log). */
    gmailUnits: () => unitsUsed,

    async getProfile() {
      const p = await call<{ emailAddress: string; historyId: string }>("getProfile", "/profile");
      if (!p) throw new Error("Gmail profile not found.");
      return p;
    },

    async listMessages(opts) {
      const { pageToken, maxResults = 100 } = opts;
      const qs = new URLSearchParams({ q: gmailQuery(opts), maxResults: String(maxResults) });
      if (pageToken) qs.set("pageToken", pageToken);
      let r;
      try {
        r = await call<{
          messages?: { id: string; threadId: string }[];
          nextPageToken?: string;
        }>("messages.list", `/messages?${qs}`);
      } catch (err) {
        // Check 25 P5: a saved token Gmail no longer takes (it answers 400): start over.
        if (pageToken && err instanceof Error && /^Gmail API 400\b/.test(err.message))
          throw new InvalidPageTokenError();
        throw err;
      }
      return { messages: r?.messages ?? [], nextPageToken: r?.nextPageToken };
    },

    async getMessage(id, { withBody, headers }): Promise<MailMessage | null> {
      const qs = new URLSearchParams({ format: withBody ? "full" : "metadata" });
      const asked = withBody ? [] : (headers ?? DEFAULT_METADATA_HEADERS);
      for (const h of asked) qs.append("metadataHeaders", h);
      const r = await call<GmailMessageResource>(
        "messages.get",
        `/messages/${encodeURIComponent(id)}?${qs}`,
      );
      // From the request we made, not from the response: a metadata read that didn't ask for
      // Reply-To says nothing about whether the email has one.
      const replyToRead = withBody || asked.some((h) => h.toLowerCase() === "reply-to");
      return r ? toMailMessage(r, withBody, { replyToRead }) : null;
    },

    async listHistory({ startHistoryId, pageToken }): Promise<HistoryPage> {
      // New messages and every label change (Check 25 P2: archive, Trash, Spam and Not spam in
      // Gmail), plus permanent deletes. A sent draft may keep its id (DRAFT swapped for SENT),
      // which history reports as a label change, so a SENT add also counts as added.
      const qs = new URLSearchParams({ startHistoryId });
      for (const t of ["messageAdded", "labelAdded", "labelRemoved", "messageDeleted"])
        qs.append("historyTypes", t);
      if (pageToken) qs.set("pageToken", pageToken);
      type Ref = { id: string; threadId: string; labelIds?: string[] };
      type Labelled = { message: Ref; labelIds?: string[] };
      const r = await call<{
        history?: {
          messagesAdded?: { message: Ref }[];
          labelsAdded?: Labelled[];
          labelsRemoved?: Labelled[];
          messagesDeleted?: { message: Ref }[];
        }[];
        nextPageToken?: string;
        historyId: string;
      }>("history.list", `/history?${qs}`);
      if (!r) throw new HistoryExpiredError();
      const history = r.history ?? [];
      const added = history.flatMap((h) => [
        ...(h.messagesAdded ?? []).map((m) => ({
          id: m.message.id,
          threadId: m.message.threadId,
          ...(m.message.labelIds ? { labelIds: m.message.labelIds } : {}),
        })),
        ...(h.labelsAdded ?? [])
          .filter((l) => (l.labelIds ?? []).includes("SENT"))
          .map((l) => ({ id: l.message.id, threadId: l.message.threadId })),
      ]);
      const labelChanges = history.flatMap((h) => [
        ...(h.labelsAdded ?? []).map((l) => ({
          id: l.message.id,
          threadId: l.message.threadId,
          added: l.labelIds ?? [],
          removed: [],
        })),
        ...(h.labelsRemoved ?? []).map((l) => ({
          id: l.message.id,
          threadId: l.message.threadId,
          added: [],
          removed: l.labelIds ?? [],
        })),
      ]);
      const deleted = history.flatMap((h) =>
        (h.messagesDeleted ?? []).map((m) => ({ id: m.message.id, threadId: m.message.threadId })),
      );
      return {
        added,
        labelChanges,
        deleted,
        nextPageToken: r.nextPageToken,
        historyId: r.historyId,
      };
    },

    async createDraft({ threadId, raw }) {
      const r = await call<{ id: string; message: { id: string } }>("drafts.create", "/drafts", {
        method: "POST",
        body: { message: { raw, threadId } },
      });
      if (!r) throw new Error("Gmail draft create failed.");
      return { draftId: r.id, messageId: r.message.id };
    },

    async getDraft(draftId) {
      const r = await call<{ id: string; message: GmailMessageResource }>(
        "drafts.get",
        `/drafts/${encodeURIComponent(draftId)}?format=full`,
      );
      if (!r) return null;
      return {
        draftId: r.id,
        messageId: r.message.id,
        threadId: r.message.threadId,
        bodyText: extractBodyText(r.message.payload) ?? "",
      };
    },

    async updateDraft(draftId, { threadId, raw }) {
      const r = await call<{ id: string; message: { id: string } }>(
        "drafts.update",
        `/drafts/${encodeURIComponent(draftId)}`,
        {
          method: "PUT",
          body: { id: draftId, message: { raw, threadId } },
        },
      );
      if (!r) throw new Error("Gmail draft no longer exists.");
      return { messageId: r.message.id };
    },

    async deleteDraft(draftId) {
      await call("drafts.delete", `/drafts/${encodeURIComponent(draftId)}`, { method: "DELETE" });
    },

    async threadDraftMessageIds(threadId) {
      return (await threadMessageLabels(threadId))
        .filter((m) => m.labelIds.includes("DRAFT") && !m.labelIds.includes("SENT"))
        .map((m) => m.id);
    },

    threadMessageLabels,

    async sendDraft(draftId) {
      const r = await call<{ id: string; threadId: string }>("drafts.send", "/drafts/send", {
        method: "POST",
        body: { id: draftId },
      });
      if (!r) throw new Error("Gmail draft no longer exists.");
      return { messageId: r.id, threadId: r.threadId };
    },

    async sendMessage(raw) {
      const r = await call<{ id: string }>("messages.send", "/messages/send", {
        method: "POST",
        body: { raw },
      });
      if (!r) throw new Error("Gmail send failed.");
      return { messageId: r.id };
    },

    async watch(topicName) {
      const r = await call<{ historyId: string; expiration: string }>("watch", "/watch", {
        method: "POST",
        // Check 25 P4: the owner's own sends too, so the poll can stand back while push works.
        body: { topicName, labelIds: ["INBOX", "SENT"], labelFilterBehavior: "include" },
      });
      if (!r) throw new Error("Gmail watch failed.");
      return { historyId: r.historyId, expiration: Number(r.expiration) };
    },
  };
}
