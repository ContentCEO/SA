import {
  HistoryExpiredError,
  MailboxAuthError,
  type LabelChange,
  type MailboxReader,
  type MailMessage,
} from "@/mailbox/connector";

type Stored = MailMessage & { historyId: number };

/** One record of Gmail's history, typed like the real API's (Check 25 P2 / P8). */
export type HistoryRecord = {
  historyId: number;
  type: "messageAdded" | "labelAdded" | "labelRemoved" | "messageDeleted";
  id: string;
  threadId: string;
  /** messageAdded: the message's labels; labelAdded / labelRemoved: the labels changed. */
  labelIds: string[];
};

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
  /** Gmail's history log, as typed records. */
  log: HistoryRecord[] = [];

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
      ...(m.attachments ? { attachments: m.attachments } : {}),
      historyId: this.history,
    });
    this.log.push({
      historyId: this.history,
      type: "messageAdded",
      id: m.id,
      threadId: m.threadId,
      labelIds: m.labelIds ?? ["INBOX"],
    });
  }

  /**
   * Change a message's labels in place (same id), as Gmail may do when a draft is sent
   * (DRAFT → SENT). History reports it (a label added), so it shows up in `listHistory`.
   */
  relabel(id: string, labelIds: string[], daysAgo?: number) {
    const m = this.messages.find((x) => x.providerMessageId === id)!;
    this.history += 1;
    const added = labelIds.filter((l) => !m.labelIds.includes(l));
    const removed = m.labelIds.filter((l) => !labelIds.includes(l));
    const ref = { historyId: this.history, id, threadId: m.providerThreadId };
    if (added.length) this.log.push({ ...ref, type: "labelAdded", labelIds: added });
    if (removed.length) this.log.push({ ...ref, type: "labelRemoved", labelIds: removed });
    m.labelIds = labelIds;
    m.historyId = this.history;
    if (daysAgo !== undefined)
      m.internalDate = new Date("2026-09-28T12:00:00Z").getTime() - daysAgo * 86_400_000;
  }

  /** What the owner does in Gmail (Check 25 P2). */
  archive(id: string) {
    const m = this.find(id);
    this.relabel(
      id,
      m.labelIds.filter((l) => l !== "INBOX"),
    );
  }
  trash(id: string) {
    const m = this.find(id);
    this.relabel(id, [...m.labelIds.filter((l) => l !== "INBOX"), "TRASH"]);
  }
  spam(id: string) {
    const m = this.find(id);
    this.relabel(id, [...m.labelIds.filter((l) => l !== "INBOX"), "SPAM"]);
  }
  notSpam(id: string) {
    const m = this.find(id);
    this.relabel(id, [...m.labelIds.filter((l) => l !== "SPAM"), "INBOX"]);
  }
  /** Deleted for good (emptied from Trash). */
  remove(id: string) {
    const m = this.find(id);
    this.history += 1;
    this.messages = this.messages.filter((x) => x.providerMessageId !== id);
    this.log.push({
      historyId: this.history,
      type: "messageDeleted",
      id,
      threadId: m.providerThreadId,
      labelIds: [],
    });
  }
  private find(id: string) {
    const m = this.messages.find((x) => x.providerMessageId === id);
    if (!m) throw new Error(`no message ${id}`);
    return m;
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
      listMessages: async ({ newerThanDays, after, inbox, sentOnly, pageToken, maxResults }) => {
        guard();
        const cutoff = after
          ? Math.floor(after.getTime() / 1000) * 1000 // Gmail's after: is in whole seconds
          : new Date("2026-09-28T12:00:00Z").getTime() - (newerThanDays ?? 9999) * 86_400_000;
        // Like Gmail: inbox only / everything but; Spam and Trash are never listed.
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
        return withBody
          ? {
              ...copy,
              bodyText: m.bodyText,
              ...(m.attachments ? { attachments: m.attachments } : {}),
            }
          : copy;
      },
      listHistory: async ({ startHistoryId }) => {
        guard();
        const start = Number(startHistoryId);
        if (start < this.oldestHistory) throw new HistoryExpiredError();
        // Like the real client: new messages (with their labels) and SENT label adds count as
        // added; every label change and permanent delete is reported as such.
        const recent = this.log.filter((h) => h.historyId > start);
        const added = recent.flatMap((h) =>
          h.type === "messageAdded"
            ? [{ id: h.id, threadId: h.threadId, labelIds: h.labelIds }]
            : h.type === "labelAdded" && h.labelIds.includes("SENT")
              ? [{ id: h.id, threadId: h.threadId }]
              : [],
        );
        const labelChanges = recent.flatMap((h): LabelChange[] =>
          h.type === "labelAdded"
            ? [{ id: h.id, threadId: h.threadId, added: h.labelIds, removed: [] }]
            : h.type === "labelRemoved"
              ? [{ id: h.id, threadId: h.threadId, added: [], removed: h.labelIds }]
              : [],
        );
        const deleted = recent
          .filter((h) => h.type === "messageDeleted")
          .map((h) => ({ id: h.id, threadId: h.threadId }));
        return { added, labelChanges, deleted, historyId: String(this.history) };
      },
      watch: async () => {
        guard();
        return { historyId: String(this.history), expiration: Date.now() + 7 * 86_400_000 };
      },
    };
  }
}
