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
      listMessages: async ({ query, pageToken }) => {
        guard();
        const days = Number(/newer_than:(\d+)d/.exec(query)?.[1] ?? 9999);
        const cutoff = new Date("2026-09-28T12:00:00Z").getTime() - days * 86_400_000;
        const all = this.messages
          .filter((m) => m.internalDate >= cutoff)
          .map((m) => ({ id: m.providerMessageId, threadId: m.providerThreadId }));
        const start = Number(pageToken ?? 0);
        const next = start + pageSize;
        return {
          messages: all.slice(start, next),
          nextPageToken: next < all.length ? String(next) : undefined,
        };
      },
      getMessage: async (id, { withBody }) => {
        guard();
        const m = this.messages.find((x) => x.providerMessageId === id);
        if (!m) return null;
        if (withBody) this.bodyFetches.push(id);
        const copy: MailMessage = {
          providerMessageId: m.providerMessageId,
          providerThreadId: m.providerThreadId,
          labelIds: m.labelIds,
          snippet: m.snippet,
          internalDate: m.internalDate,
          headers: m.headers,
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
