import type { MailMessage } from "../connector";

/** The slice of Gmail's `users.messages` resource we read. */
export type GmailMessagePart = {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { data?: string; size?: number };
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

export function toMailMessage(resource: GmailMessageResource, withBody: boolean): MailMessage {
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
    },
    bodyText: withBody ? extractBodyText(p) : undefined,
  };
}

/** "Dana Ruiz <dana@x.com>, b@y.com" → [{name, email}] (lowercased emails). */
export function parseAddressList(value: string | undefined): { name?: string; email: string }[] {
  if (!value) return [];
  const out: { name?: string; email: string }[] = [];
  // Split on commas that are not inside quotes.
  for (const raw of value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)) {
    const part = raw.trim();
    if (!part) continue;
    const angle = part.match(/^(.*)<([^>]+)>$/);
    if (angle) {
      const name = angle[1]!.trim().replace(/^"|"$/g, "").trim();
      out.push({ name: name || undefined, email: angle[2]!.trim().toLowerCase() });
    } else if (part.includes("@")) {
      out.push({ email: part.toLowerCase() });
    }
  }
  return out;
}
