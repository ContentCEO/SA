import { Buffer } from "node:buffer";
import type { MailboxWriter, RemoteDraft } from "@/mailbox/connector";

type Stored = { threadId: string; raw: string; messageId: string };

/** In-memory Gmail drafts. Records every call so tests can prove what did (and didn't) happen. */
export class FakeWriter implements MailboxWriter {
  drafts = new Map<string, Stored>();
  sent: { draftId: string; raw: string }[] = [];
  calls: string[] = [];
  private n = 0;

  static bodyOf(raw: string): string {
    const mime = Buffer.from(raw, "base64url").toString("utf8");
    const [, b64 = ""] = mime.split("\r\n\r\n");
    return Buffer.from(b64.replace(/\r\n/g, ""), "base64").toString("utf8").replace(/\r\n/g, "\n");
  }
  static headersOf(raw: string): string {
    return Buffer.from(raw, "base64url").toString("utf8").split("\r\n\r\n")[0]!;
  }

  /** Simulate the owner editing the draft in Gmail. */
  editInGmail(draftId: string, body: string) {
    const d = this.drafts.get(draftId)!;
    const mime = Buffer.from(d.raw, "base64url").toString("utf8").split("\r\n\r\n")[0]!;
    d.raw = Buffer.from(`${mime}\r\n\r\n${Buffer.from(body).toString("base64")}`).toString(
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
  async sendDraft(draftId: string) {
    this.calls.push("sendDraft");
    const d = this.drafts.get(draftId);
    if (!d) throw new Error("gone");
    this.sent.push({ draftId, raw: d.raw });
    this.drafts.delete(draftId);
    return { messageId: `sent-${draftId}`, threadId: d.threadId };
  }
}
