/**
 * Build an RFC 2822 reply. Header values are stripped of CR/LF so text from an
 * email (a subject, an address) can never inject extra headers.
 */
export type ReplyMime = {
  from: string;
  to: string;
  subject: string;
  inReplyTo?: string | null;
  references?: string | null;
  body: string;
};

const clean = (v: string) => v.replace(/[\r\n]+/g, " ").trim();

/** RFC 2047 encoded-word for non-ASCII header text. */
export function encodeHeader(value: string): string {
  const v = clean(value);
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, "utf8").toString("base64")}?=`;
}

export function replySubject(subject: string | null | undefined): string {
  const s = clean(subject ?? "");
  if (!s) return "Re: your email";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

export function buildReplyMime(m: ReplyMime): string {
  const headers = [
    `From: ${clean(m.from)}`,
    `To: ${clean(m.to)}`,
    `Subject: ${encodeHeader(m.subject)}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
  ];
  const inReplyTo = m.inReplyTo ? clean(m.inReplyTo) : null;
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    const refs = [m.references ? clean(m.references) : "", inReplyTo].filter(Boolean).join(" ");
    headers.push(`References: ${refs}`);
  }
  const body = Buffer.from(m.body.replace(/\r?\n/g, "\r\n"), "utf8")
    .toString("base64")
    .replace(/.{76}/g, "$&\r\n");
  return `${headers.join("\r\n")}\r\n\r\n${body}`;
}

/** Gmail wants the whole message base64url-encoded. */
export function toGmailRaw(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}

/** Compare draft text loosely: line endings, trailing space, and blank-line runs don't count as edits. */
export function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) =>
    (s ?? "")
      .replace(/\r\n/g, "\n")
      .split("\n")
      .map((l) => l.trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  return norm(a) === norm(b);
}
