import { MAIL_LABELS, type MailMessage } from "../connector";
import { MAX_BODY_CHARS } from "../gmail/parse";

/**
 * Plan #49: Microsoft Graph's message resource, as far as we read it, mapped onto the
 * provider-neutral `MailMessage` sync stores. Pure (no network, no `server-only`).
 */

export type GraphRecipient = { emailAddress?: { name?: string | null; address?: string | null } };

export type GraphMessage = {
  id: string;
  conversationId?: string;
  parentFolderId?: string;
  isDraft?: boolean;
  receivedDateTime?: string | null;
  sentDateTime?: string | null;
  subject?: string | null;
  from?: GraphRecipient | null;
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  replyTo?: GraphRecipient[];
  internetMessageId?: string | null;
  internetMessageHeaders?: { name: string; value: string }[] | null;
  bodyPreview?: string | null;
  body?: { contentType?: string; content?: string | null } | null;
  hasAttachments?: boolean;
};

export type GraphAttachment = { contentType?: string | null; size?: number; isInline?: boolean };

/** The well-known folders whose ids we map onto MAIL_LABELS. */
export const WELL_KNOWN_FOLDERS = [
  "inbox",
  "sentitems",
  "drafts",
  "deleteditems",
  "junkemail",
] as const;
export type WellKnownFolder = (typeof WELL_KNOWN_FOLDERS)[number];
export type FolderIds = Record<WellKnownFolder, string>;

const FOLDER_LABEL: Record<WellKnownFolder, string> = {
  inbox: MAIL_LABELS.inbox,
  sentitems: MAIL_LABELS.sent,
  drafts: MAIL_LABELS.draft,
  deleteditems: MAIL_LABELS.trash,
  junkemail: MAIL_LABELS.spam,
};

/**
 * The labels shared code reads, from the folder a message is in. Mail in any other folder
 * (Archive, the owner's own folders) has none, like an archived Gmail email. A draft is DRAFT
 * wherever it sits. No Promotions / Social: Outlook's Focused / Other split is not the same
 * thing (customers land in Other all the time), so nothing skips sorting on it.
 */
export function labelsFor(m: Pick<GraphMessage, "parentFolderId" | "isDraft">, folders: FolderIds) {
  const labels: string[] = [];
  for (const f of WELL_KNOWN_FOLDERS)
    if (m.parentFolderId && m.parentFolderId === folders[f]) labels.push(FOLDER_LABEL[f]);
  if (m.isDraft && !labels.includes(MAIL_LABELS.draft)) labels.push(MAIL_LABELS.draft);
  return labels;
}

/** `Name <address>`, quoted when the name needs it, for parseAddressList. */
function formatAddress(r: GraphRecipient | null | undefined): string | null {
  const address = r?.emailAddress?.address?.trim();
  if (!address) return null;
  const name = (r?.emailAddress?.name ?? "").replace(/[\r\n"\\]/g, " ").trim();
  return name && name.toLowerCase() !== address.toLowerCase() ? `"${name}" <${address}>` : address;
}

function formatList(list: GraphRecipient[] | undefined): string | undefined {
  const out = (list ?? []).map(formatAddress).filter((a): a is string => !!a);
  return out.length ? out.join(", ") : undefined;
}

function header(m: GraphMessage, name: string): string | undefined {
  const lower = name.toLowerCase();
  return m.internetMessageHeaders?.find((h) => h.name.toLowerCase() === lower)?.value;
}

/** Inline images smaller than this (signature logos) aren't attachments, as for Gmail. */
const INLINE_IMAGE_MIN_BYTES = 10 * 1024;

/** Counts by kind only: never a name or content (Check 40 P2). */
export function countGraphAttachments(list: GraphAttachment[]) {
  const out = { images: 0, pdfs: 0, other: 0 };
  for (const a of list) {
    const mime = (a.contentType ?? "").toLowerCase();
    if (mime.startsWith("image/")) {
      if (!(a.isInline && (a.size ?? 0) < INLINE_IMAGE_MIN_BYTES)) out.images++;
    } else if (mime === "application/pdf") out.pdfs++;
    else out.other++;
  }
  return out;
}

export function toMailMessage(
  m: GraphMessage,
  folders: FolderIds,
  withBody: boolean,
  attachments?: { images: number; pdfs: number; other: number },
): MailMessage {
  const when = Date.parse(m.receivedDateTime ?? m.sentDateTime ?? "");
  return {
    providerMessageId: m.id,
    providerThreadId: m.conversationId ?? m.id,
    labelIds: labelsFor(m, folders),
    snippet: m.bodyPreview ?? "",
    internalDate: Number.isFinite(when) ? when : Date.now(),
    headers: {
      from: formatAddress(m.from) ?? undefined,
      to: formatList(m.toRecipients),
      cc: formatList(m.ccRecipients),
      subject: m.subject ?? undefined,
      messageId: m.internetMessageId ?? undefined,
      references: header(m, "References"),
      inReplyTo: header(m, "In-Reply-To"),
      replyTo: formatList(m.replyTo),
      // Every read selects replyTo, so "none" is a real answer.
      replyToRead: true,
      autoSubmitted: header(m, "Auto-Submitted"),
      xAutoreply: header(m, "X-Autoreply"),
      xAutorespond: header(m, "X-Autorespond"),
      precedence: header(m, "Precedence"),
      autoResponseSuppress: header(m, "X-Auto-Response-Suppress"),
    },
    bodyText: withBody
      ? (m.body?.content ?? "").trim().slice(0, MAX_BODY_CHARS) || undefined
      : undefined,
    ...(withBody ? { attachments: attachments ?? { images: 0, pdfs: 0, other: 0 } } : {}),
  };
}
