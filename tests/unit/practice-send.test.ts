import { randomBytes } from "node:crypto";
import { Buffer } from "node:buffer";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@/db";
import { drafts, threads, workspaces } from "@/db/schema";
import { buildReplyMime } from "@/mailbox/mime";
import { ensureUserAndWorkspace } from "@/server/accounts";
import { queueSend, sendDraft } from "@/server/drafts";
import {
  canPracticeSend,
  mimeRecipients,
  onlyToOwner,
  PRACTICE_SEND_LIMIT,
  SendingBlockedError,
} from "@/server/lifecycle";
import { saveConnectedMailbox } from "@/server/mailboxes";
import { practiceSend } from "@/server/practice";
import { createTestDb } from "../support/db";
import { FakeWriter } from "../support/fake-writer";

const NOW = new Date("2026-10-11T15:00:00Z");
const OWNER = "owner@shop.com";

describe("#40 practice sends during evaluation", () => {
  it("the recipient rule reads every To, Cc and Bcc, folded lines included", () => {
    const toOwner = buildReplyMime({ from: OWNER, to: OWNER, subject: "x", body: "hi" });
    expect(onlyToOwner(toOwner, "Owner@Shop.com")).toBe(true);
    const toCustomer = buildReplyMime({ from: OWNER, to: "dana@x.com", subject: "x", body: "hi" });
    expect(onlyToOwner(toCustomer, OWNER)).toBe(false);
    const ccCustomer = `From: ${OWNER}\r\nTo: ${OWNER}\r\nCc: Dana <dana@x.com>\r\n\r\nhi`;
    expect(onlyToOwner(ccCustomer, OWNER)).toBe(false);
    const bccFolded = `To: ${OWNER}\r\nBcc: someone@else.com,\r\n  dana@x.com\r\n\r\nhi`;
    expect(mimeRecipients(bccFolded)).toEqual([OWNER, "someone@else.com", "dana@x.com"]);
    expect(onlyToOwner(bccFolded, OWNER)).toBe(false);
    expect(onlyToOwner("Subject: no recipients\r\n\r\nhi", OWNER)).toBe(false);
  });

  it("only while evaluating — not invited, not expired, not paid", () => {
    const later = new Date(NOW.getTime() + 86_400_000);
    expect(canPracticeSend({ status: "evaluating", evaluationEndsAt: later }, NOW)).toBe(true);
    expect(canPracticeSend({ status: "evaluating", evaluationEndsAt: NOW }, NOW)).toBe(false);
    expect(canPracticeSend({ status: "invited", evaluationEndsAt: null }, NOW)).toBe(false);
    expect(canPracticeSend({ status: "active", evaluationEndsAt: null }, NOW)).toBe(false);
  });

  describe("in the database", () => {
    let database: Database;
    let workspaceId: string;
    let draftId: string;
    let writer: FakeWriter;
    const deps = () => ({ writerFor: () => writer, now: () => NOW });

    beforeEach(async () => {
      process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
      database = await createTestDb();
      const { workspace } = await ensureUserAndWorkspace({ email: OWNER });
      workspaceId = workspace.id;
      const mailbox = await saveConnectedMailbox(workspace, {
        email: OWNER,
        refreshToken: "rt",
        grantedScopes: [],
      });
      await database
        .update(workspaces)
        .set({ status: "evaluating", evaluationEndsAt: new Date(NOW.getTime() + 86_400_000) })
        .where(eq(workspaces.id, workspaceId));
      const [t] = await database
        .insert(threads)
        .values({ mailboxId: mailbox.id, gmailThreadId: "customer-thread", inInbox: true })
        .returning();
      writer = new FakeWriter();
      const g = await writer.createDraft({ threadId: "customer-thread", raw: "" });
      const [d] = await database
        .insert(drafts)
        .values({
          threadId: t!.id,
          mailboxId: mailbox.id,
          gmailDraftId: g.draftId,
          toAddress: "dana@x.com",
          subject: "Re: Deck",
          body: "Hi Dana, what's the address?",
          originalBody: "Hi Dana, what's the address?",
          reason: "r",
        })
        .returning();
      draftId = d!.id;
      writer.calls.length = 0;
    });

    it("sends a new, unthreaded [Practice] message to the owner only; the draft stays put", async () => {
      const r = await practiceSend(workspaceId, draftId, deps());
      expect(r).toEqual({ status: "sent", to: OWNER, left: PRACTICE_SEND_LIMIT - 1 });
      expect(writer.calls).toEqual(["sendMessage"]); // never sendDraft, never the customer's draft
      const mime = Buffer.from(writer.messages[0]!, "base64url").toString("utf8");
      expect(mimeRecipients(mime)).toEqual([OWNER]);
      expect(mime).toMatch(/^Subject: \[Practice\] Re: Deck$/m);
      expect(mime).not.toMatch(/In-Reply-To|References/);
      const [d] = await database.select().from(drafts);
      expect(d!.status).toBe("pending");
    });

    it("a real send to the customer stays 403 during evaluation, with no Gmail call", async () => {
      await expect(sendDraft(workspaceId, draftId, deps())).rejects.toThrow(SendingBlockedError);
      await expect(queueSend(workspaceId, draftId, deps())).rejects.toThrow(SendingBlockedError);
      expect(writer.calls).toEqual([]);
    });

    it("the 11th practice send is refused", async () => {
      for (let i = 0; i < PRACTICE_SEND_LIMIT; i++)
        expect((await practiceSend(workspaceId, draftId, deps())).status).toBe("sent");
      expect(await practiceSend(workspaceId, draftId, deps())).toEqual({ status: "limit" });
      expect(writer.messages).toHaveLength(PRACTICE_SEND_LIMIT);
    });

    it("refused (403) once the three days are over, or once paid", async () => {
      await database
        .update(workspaces)
        .set({ evaluationEndsAt: new Date(NOW.getTime() - 1000) })
        .where(eq(workspaces.id, workspaceId));
      await expect(practiceSend(workspaceId, draftId, deps())).rejects.toThrow(SendingBlockedError);
      await database
        .update(workspaces)
        .set({ status: "active", setupPaidVia: "stripe" })
        .where(eq(workspaces.id, workspaceId));
      await expect(practiceSend(workspaceId, draftId, deps())).rejects.toThrow(SendingBlockedError);
      expect(writer.calls).toEqual([]);
    });

    it("another workspace can't practice-send someone else's draft", async () => {
      const other = await ensureUserAndWorkspace({ email: "other@shop.com" });
      expect(await practiceSend(other.workspace.id, draftId, deps())).toEqual({
        status: "not_found",
      });
    });
  });
});
