import { Buffer } from "node:buffer";
import type { MailboxWriter, MailMessage, RemoteDraft } from "@/mailbox/connector";

type Stored = { threadId: string; raw: string; messageId: string };

/** In-memory Gmail drafts. Records every call so tests can prove what did (and didn't) happen. */
export class FakeWriter implements MailboxWriter {
  drafts = new Map<string, Stored>();
  sent: { draftId: string; raw: string }[] = [];
  calls: string[] = [];
  private n = 0;

  /**
   * The plain text, as Gmail's parser reads it (text/plain first): our multipart/alternative
   * replies (Check 43 P6) and single-part bodies (old drafts, edits made "in Gmail") alike.
   */
  static bodyOf(raw: string): string {
    return FakeWriter.partOf(raw, "text/plain");
  }
  /** One part's decoded text (text/plain or text/html); a single-part body is its own part. */
  static partOf(raw: string, type: "text/plain" | "text/html"): string {
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    const split = mime.indexOf("\r\n\r\n");
    const head = split === -1 ? mime : mime.slice(0, split);
    const rest = split === -1 ? "" : mime.slice(split + 4);
    const decode = (b64: string) =>
      Buffer.from(b64.replace(/\s+/g, ""), "base64").toString("utf8").replace(/\r\n/g, "\n");
    const boundary = head.match(/boundary="([^"]+)"/i)?.[1];
    if (!boundary) return type === "text/plain" ? decode(rest) : "";
    for (const chunk of rest.split(`--${boundary}`)) {
      const at = chunk.indexOf("\r\n\r\n");
      if (at === -1) continue;
      if (new RegExp(`content-type:\\s*${type}`, "i").test(chunk.slice(0, at)))
        return decode(chunk.slice(at + 4));
    }
    return "";
  }
  static headersOf(raw: string): string {
    return Buffer.from(raw, "base64url").toString("utf8").split("\r\n\r\n")[0]!;
  }

  /**
   * The Gmail client is reader and writer in one, so drafting reads a stored email's
   * Reply-To through it when sync never did. Default: read, none there. Kept out of `calls`.
   */
  replyTo = new Map<string, string>();
  replyToReads: string[] = [];
  replyToError: Error | null = null;
  async getMessage(
    id: string,
    _opts: { withBody: boolean; headers?: readonly string[] },
  ): Promise<MailMessage | null> {
    void _opts;
    this.replyToReads.push(id);
    if (this.replyToError) throw this.replyToError;
    const m: MailMessage = {
      providerMessageId: id,
      providerThreadId: "",
      labelIds: [],
      snippet: "",
      internalDate: 0,
      headers: { replyTo: this.replyTo.get(id), replyToRead: true },
    };
    return m;
  }

  /** Simulate the owner editing the draft in Gmail. */
  editInGmail(draftId: string, body: string) {
    const d = this.drafts.get(draftId)!;
    // Gmail saves the owner's edit as its own message: kept headers, a new single text part.
    const head = Buffer.from(d.raw, "base64url")
      .toString("utf8")
      .split("\r\n\r\n")[0]!
      .split("\r\n")
      .filter((l) => !/^content-(type|transfer-encoding):/i.test(l))
      .concat('Content-Type: text/plain; charset="UTF-8"', "Content-Transfer-Encoding: base64")
      .join("\r\n");
    d.raw = Buffer.from(`${head}\r\n\r\n${Buffer.from(body).toString("base64")}`).toString(
      "base64url",
    );
  }

  async createDraft({ threadId, raw }: { threadId: string; raw: string }) {
    this.calls.push("createDraft");
    const draftId = `d${++this.n}`;
    const messageId = `dm${this.n}`;
    this.drafts.set(draftId, { threadId, raw, messageId });
    return { draftId, messageId };
  }
  async getDraft(draftId: string): Promise<RemoteDraft | null> {
    this.calls.push("getDraft");
    const d = this.drafts.get(draftId);
    return d
      ? {
          draftId,
          messageId: d.messageId,
          threadId: d.threadId,
          bodyText: FakeWriter.bodyOf(d.raw),
        }
      : null;
  }
  async updateDraft(draftId: string, { threadId, raw }: { threadId: string; raw: string }) {
    this.calls.push("updateDraft");
    const d = this.drafts.get(draftId);
    if (!d) throw new Error("gone");
    this.drafts.set(draftId, { ...d, threadId, raw });
    return { messageId: d.messageId };
  }
  async deleteDraft(draftId: string) {
    this.calls.push("deleteDraft");
    this.drafts.delete(draftId);
  }
  /** Every draft in the thread: ours, and any the owner started in Gmail (`createDraft`). */
  async threadDraftMessageIds(threadId: string) {
    this.calls.push("threadDraftMessageIds");
    return [...this.drafts.values()].filter((d) => d.threadId === threadId).map((d) => d.messageId);
  }
  /**
   * Check 20 P2: mail on a thread that isn't a draft (as Gmail lists it), per thread id. Empty
   * by default: tests add an id here for mail that hasn't synced yet.
   */
  threadMail = new Map<string, { id: string; labelIds: string[] }[]>();
  async threadMessageLabels(threadId: string) {
    this.calls.push("threadMessageLabels");
    return [
      ...(this.threadMail.get(threadId) ?? []),
      ...[...this.drafts.values()]
        .filter((d) => d.threadId === threadId)
        .map((d) => ({ id: d.messageId, labelIds: ["DRAFT"] })),
    ];
  }
  /** Practice sends (#40): brand-new messages, recorded with their raw MIME. */
  messages: string[] = [];
  async sendMessage(raw: string) {
    this.calls.push("sendMessage");
    this.messages.push(raw);
    return { messageId: `msg-${this.messages.length}` };
  }
  async sendDraft(draftId: string) {
    this.calls.push("sendDraft");
    const d = this.drafts.get(draftId);
    if (!d) throw new Error("gone");
    this.sent.push({ draftId, raw: d.raw });
    this.drafts.delete(draftId);
    return { messageId: `sent-${draftId}`, threadId: d.threadId };
  }
}
