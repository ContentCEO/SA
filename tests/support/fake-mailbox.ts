import {
  HistoryExpiredError,
  MailboxAuthError,
  type MailboxReader,
  type MailMessage,
} from "@/mailbox/connector";

type Stored = MailMessage & { historyId: number };

/**
 * In-memory stand-in for a Gmail mailbox. Bodies are only handed out when
 * asked for, so tests can prove we don't fetch what we don't need.
 */
export class FakeMailbox {
  messages: Stored[] = [];
  history = 100;
  /** History older than this is "expired" (Gmail returns 404). */
  oldestHistory = 0;
  revoked = false;
  bodyFetches: string[] = [];
  /** Metadata reads (no body), by id. */
  metaFetches: string[] = [];
  /** Metadata reads that asked for only some headers (the Reply-To backfill / lazy read). */
  headerRequests: { id: string; headers: readonly string[] }[] = [];
  calls = 0;

  add(m: Partial<MailMessage> & { id: string; threadId: string; daysAgo?: number; now?: Date }) {
    const now = m.now ?? new Date("2026-09-28T12:00:00Z");
    this.history += 1;
    this.messages.push({
      providerMessageId: m.id,
      providerThreadId: m.threadId,
      labelIds: m.labelIds ?? ["INBOX"],
      snippet: m.snippet ?? `snippet ${m.id}`,
      internalDate: now.getTime() - (m.daysAgo ?? 1) * 86_400_000,
      headers: m.headers ?? {
        from: `Customer <customer-${m.threadId}@example.com>`,
        to: "owner@shop.com",
        subject: `Subject ${m.threadId}`,
        messageId: `<${m.id}@mail.example.com>`,
      },
      bodyText: m.bodyText ?? `body of ${m.id}`,
      historyId: this.history,
    });
  }

  /**
   * Change a message's labels in place (same id), as Gmail may do when a draft is sent
   * (DRAFT → SENT). History reports it (a label added), so it shows up in `listHistory`.
   */
  relabel(id: string, labelIds: string[], daysAgo?: number) {
    const m = this.messages.find((x) => x.providerMessageId === id)!;
    this.history += 1;
    m.labelIds = labelIds;
    m.historyId = this.history;
    if (daysAgo !== undefined)
      m.internalDate = new Date("2026-09-28T12:00:00Z").getTime() - daysAgo * 86_400_000;
  }

  reader(pageSize = 2): MailboxReader {
    const guard = () => {
      this.calls++;
      if (this.revoked) throw new MailboxAuthError();
    };
    return {
      getProfile: async () => {
        guard();
        return { emailAddress: "owner@shop.com", historyId: String(this.history) };
      },
      listMessages: async ({ query, pageToken, maxResults }) => {
        guard();
        const days = Number(/newer_than:(\d+)d/.exec(query)?.[1] ?? 9999);
        const cutoff = new Date("2026-09-28T12:00:00Z").getTime() - days * 86_400_000;
        const sentOnly = query.includes("in:sent");
        // Like Gmail: `in:inbox` / `-in:inbox`; Spam and Trash are never listed.
        const inbox = /(^|\s)-in:inbox/.test(query)
          ? false
          : /(^|\s)in:inbox/.test(query)
            ? true
            : undefined;
        const all = this.messages
          .filter((m) => m.internalDate >= cutoff)
          .filter((m) => !m.labelIds.includes("SPAM") && !m.labelIds.includes("TRASH"))
          .filter((m) => !sentOnly || m.labelIds.includes("SENT"))
          .filter((m) => inbox === undefined || m.labelIds.includes("INBOX") === inbox)
          .map((m) => ({ id: m.providerMessageId, threadId: m.providerThreadId }));
        const start = Number(pageToken ?? 0);
        const next = start + (maxResults ?? pageSize);
        return {
          messages: all.slice(start, next),
          nextPageToken: next < all.length ? String(next) : undefined,
        };
      },
      getMessage: async (id, { withBody, headers }) => {
        guard();
        if (!withBody && headers) this.headerRequests.push({ id, headers });
        const m = this.messages.find((x) => x.providerMessageId === id);
        if (!m) return null;
        if (withBody) this.bodyFetches.push(id);
        else this.metaFetches.push(id);
        // Like the real client: the default metadata list includes Reply-To; a subset only
        // returns what it named.
        const asked = !withBody && headers ? headers.map((h) => h.toLowerCase()) : null;
        const replyToRead = !asked || asked.includes("reply-to");
        const copy: MailMessage = {
          providerMessageId: m.providerMessageId,
          providerThreadId: m.providerThreadId,
          labelIds: m.labelIds,
          snippet: m.snippet,
          internalDate: m.internalDate,
          headers: asked
            ? { replyTo: replyToRead ? m.headers.replyTo : undefined, replyToRead }
            : { ...m.headers, replyToRead },
        };
        return withBody ? { ...copy, bodyText: m.bodyText } : copy;
      },
      listHistory: async ({ startHistoryId }) => {
        guard();
        const start = Number(startHistoryId);
        if (start < this.oldestHistory) throw new HistoryExpiredError();
        const added = this.messages
          .filter((m) => m.historyId > start)
          .map((m) => ({ id: m.providerMessageId, threadId: m.providerThreadId }));
        return { added, historyId: String(this.history) };
      },
      watch: async () => {
        guard();
        return { historyId: String(this.history), expiration: Date.now() + 7 * 86_400_000 };
      },
    };
  }
}
