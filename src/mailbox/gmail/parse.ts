import type { MailMessage } from "../connector";

/** The slice of Gmail's `users.messages` resource we read. */
export type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailMessagePart[];
};

export type GmailMessageResource = {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePart;
};

/** Keep stored bodies bounded; long quoted chains add nothing the model needs. */
export const MAX_BODY_CHARS = 20_000;

function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

function header(part: GmailMessagePart | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return part?.headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

function findPart(part: GmailMessagePart, mime: string): GmailMessagePart | undefined {
  if (part.mimeType === mime && part.body?.data && !part.filename) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mime);
    if (found) return found;
  }
  return undefined;
}

/** Crude but safe HTML → text: drop scripts/styles, turn block ends into newlines, strip tags. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractBodyText(payload: GmailMessagePart | undefined): string | undefined {
  if (!payload) return undefined;
  const plain = findPart(payload, "text/plain");
  if (plain?.body?.data) return decodeBase64Url(plain.body.data).trim().slice(0, MAX_BODY_CHARS);
  const html = findPart(payload, "text/html");
  if (html?.body?.data) return htmlToText(decodeBase64Url(html.body.data)).slice(0, MAX_BODY_CHARS);
  return undefined;
}

/** Inline images smaller than this (signature logos, tracking pixels) aren't attachments. */
const INLINE_IMAGE_MIN_BYTES = 10 * 1024;

/**
 * Check 40 P2: how many photos, PDFs and other files came with an email, by kind only. Never
 * a file name or any content. A part counts when it has a filename or an attachment
 * Content-Disposition; an inline image under 10 KB (a signature logo) doesn't.
 */
export function countAttachments(payload: GmailMessagePart | undefined): {
  images: number;
  pdfs: number;
  other: number;
} {
  const out = { images: 0, pdfs: 0, other: 0 };
  const walk = (p: GmailMessagePart) => {
    const disposition = (header(p, "Content-Disposition") ?? "").trim().toLowerCase();
    const named = !!p.filename;
    if ((named || disposition.startsWith("attachment")) && !p.parts?.length) {
      const mime = (p.mimeType ?? "").toLowerCase();
      const size = p.body?.size ?? 0;
      const inline =
        disposition.startsWith("inline") || (!disposition && !!header(p, "Content-ID"));
      if (mime.startsWith("image/")) {
        if (!(inline && size < INLINE_IMAGE_MIN_BYTES)) out.images++;
      } else if (mime === "application/pdf" || /\.pdf$/i.test(p.filename ?? "")) {
        out.pdfs++;
      } else {
        out.other++;
      }
    }
    for (const child of p.parts ?? []) walk(child);
  };
  if (payload) walk(payload);
  return out;
}

export function toMailMessage(
  resource: GmailMessageResource,
  withBody: boolean,
  opts: { replyToRead?: boolean } = {},
): MailMessage {
  const p = resource.payload;
  return {
    providerMessageId: resource.id,
    providerThreadId: resource.threadId,
    labelIds: resource.labelIds ?? [],
    snippet: resource.snippet ?? "",
    internalDate: Number(resource.internalDate ?? Date.now()),
    headers: {
      from: header(p, "From"),
      to: header(p, "To"),
      cc: header(p, "Cc"),
      subject: header(p, "Subject"),
      messageId: header(p, "Message-ID"),
      references: header(p, "References"),
      inReplyTo: header(p, "In-Reply-To"),
      replyTo: header(p, "Reply-To"),
      replyToRead: withBody || !!opts.replyToRead,
      autoSubmitted: header(p, "Auto-Submitted"),
      xAutoreply: header(p, "X-Autoreply"),
      xAutorespond: header(p, "X-Autorespond"),
      precedence: header(p, "Precedence"),
      autoResponseSuppress: header(p, "X-Auto-Response-Suppress"),
    },
    bodyText: withBody ? extractBodyText(p) : undefined,
    // Only a full read has the parts; a metadata read says nothing about attachments.
    ...(withBody ? { attachments: countAttachments(p) } : {}),
  };
}

/** Moved to src/mailbox/address.ts (Check 47 P2); re-exported so older imports keep working. */
export { parseAddressList } from "../address";
