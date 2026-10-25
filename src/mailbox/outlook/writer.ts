import "server-only";
import type { MailboxWriter, RemoteDraft } from "../connector";
import { MAIL_LABELS } from "../connector";
import type { GraphCaller } from "./http";
import { parseOwnMime, rawToBase64, rawToMime } from "./mime-parts";
import { labelsFor, type FolderIds, type GraphMessage } from "./parse";

/**
 * Plan #49: Outlook's write side over Microsoft Graph. Like Gmail's, sending is only ever "send
 * this draft" (and the trial's practice copy, which `practiceSend` checks with onlyToOwner()
 * before it gets here). The draft id IS the message id (an immutable id, so it stays the same
 * when the draft is sent and becomes the copy in Sent Items).
 *
 * - create: our own MIME (`POST /me/messages`, base64 text/plain), never `createReply` (which
 *   writes Microsoft's own quoted reply). The MIME's In-Reply-To / References put it in the
 *   conversation.
 * - update: Graph's update takes JSON fields only (subject, body, recipients; drafts only), so
 *   the parts are read back from the MIME we built and PATCHed. Chosen over delete-and-recreate:
 *   the id stays the same (drafts.gmail_draft_id stays right, no interface change) and the
 *   threading headers set at creation stay.
 * - delete: only while it is still a draft. With immutable ids a sent draft's id is the sent
 *   email: deleting it would remove the owner's copy in Sent Items.
 * - send: `POST /me/messages/{id}/send` answers 202 with no body; the sent id is the draft's.
 */

const DRAFT_SELECT = "id,conversationId,isDraft,parentFolderId,body";

type Writer = MailboxWriter;

export function createOutlookWriter(
  graph: GraphCaller,
  folderIds: () => Promise<FolderIds>,
): Writer {
  const msgPath = (id: string) => `/me/messages/${encodeURIComponent(id)}`;

  async function readDraft(id: string) {
    return graph.call<GraphMessage>(`${msgPath(id)}?$select=${encodeURIComponent(DRAFT_SELECT)}`, {
      textBody: true,
    });
  }

  async function createFromMime(raw: string) {
    const m = await graph.call<GraphMessage>("/me/messages", {
      method: "POST",
      raw: { body: rawToBase64(raw), contentType: "text/plain" },
    });
    if (!m?.id) throw new Error("Outlook draft create failed.");
    return m;
  }

  async function threadMessageLabels(threadId: string) {
    // Ids and folders only: no headers, preview or text.
    const qs = new URLSearchParams({
      $filter: `conversationId eq '${threadId.replace(/'/g, "''")}'`,
      $select: "id,parentFolderId,isDraft,receivedDateTime",
      $top: "100",
    });
    const r = await graph.call<{ value?: GraphMessage[] }>(`/me/messages?${qs}`);
    const ids = await folderIds();
    return (r?.value ?? [])
      .slice()
      .sort((a, b) => Date.parse(a.receivedDateTime ?? "") - Date.parse(b.receivedDateTime ?? ""))
      .map((m) => ({ id: m.id, labelIds: labelsFor(m, ids) }));
  }

  return {
    async createDraft({ threadId, raw }) {
      const m = await createFromMime(raw);
      // Exchange threads a MIME upload by its In-Reply-To / References; if it ever doesn't,
      // say so (ids only) — the app still ties the draft to its own thread row.
      if (m.conversationId && m.conversationId !== threadId)
        console.error("outlook_draft_new_conversation", { draftId: m.id });
      return { draftId: m.id, messageId: m.id };
    },

    async getDraft(draftId): Promise<RemoteDraft | null> {
      const m = await readDraft(draftId);
      // Gone, or sent (no longer a draft): null, as Gmail's drafts.get would say.
      if (!m || !m.isDraft) return null;
      return {
        draftId: m.id,
        messageId: m.id,
        threadId: m.conversationId ?? "",
        bodyText: (m.body?.content ?? "").trim(),
      };
    },

    async updateDraft(draftId, { raw }) {
      const parts = parseOwnMime(rawToMime(raw));
      const current = await readDraft(draftId);
      if (!current || !current.isDraft) throw new Error("Outlook draft no longer exists.");
      const recipients = (list: typeof parts.to) =>
        list.map((a) => ({
          emailAddress: { address: a.email, ...(a.name ? { name: a.name } : {}) },
        }));
      const m = await graph.call<GraphMessage>(msgPath(draftId), {
        method: "PATCH",
        json: {
          subject: parts.subject,
          body: { contentType: "html", content: parts.html },
          toRecipients: recipients(parts.to),
          ccRecipients: recipients(parts.cc),
        },
      });
      if (!m) throw new Error("Outlook draft no longer exists.");
      return { messageId: draftId };
    },

    async deleteDraft(draftId) {
      const m = await readDraft(draftId);
      if (!m || !m.isDraft) return;
      await graph.call(msgPath(draftId), { method: "DELETE" });
    },

    async threadDraftMessageIds(threadId) {
      return (await threadMessageLabels(threadId))
        .filter(
          (m) => m.labelIds.includes(MAIL_LABELS.draft) && !m.labelIds.includes(MAIL_LABELS.sent),
        )
        .map((m) => m.id);
    },

    threadMessageLabels,

    async sendDraft(draftId) {
      const m = await readDraft(draftId);
      if (!m || !m.isDraft) throw new Error("Outlook draft no longer exists.");
      const r = await graph.call(`${msgPath(draftId)}/send`, { method: "POST" });
      if (!r) throw new Error("Outlook draft no longer exists.");
      return { messageId: m.id, threadId: m.conversationId ?? "" };
    },

    async sendMessage(raw) {
      // Practice copies only (onlyToOwner() already checked this exact MIME). Graph's sendMail
      // returns no id, so the copy is made as a draft and that draft sent: same id after.
      const m = await createFromMime(raw);
      const r = await graph.call(`${msgPath(m.id)}/send`, { method: "POST" });
      if (!r) throw new Error("Outlook send failed.");
      return { messageId: m.id };
    },
  };
}
