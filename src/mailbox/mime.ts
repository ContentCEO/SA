import { randomBytes } from "node:crypto";

/**
 * Build an RFC 2822 reply. Header values are stripped of CR/LF so text from an
 * email (a subject, an address) can never inject extra headers.
 */
export type ReplyMime = {
  from: string;
  /** Check 43 P3: the name customers see ("Mike Rossi"). Empty = the bare address. */
  fromName?: string | null;
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

/**
 * Check 43 P3: an address with its display name. No name → the address; a plain ASCII name →
 * "Name" <email> (quotes and backslashes escaped); anything else → an RFC 2047 word. CR/LF in
 * either part can never start a new header.
 */
export function formatAddress(name: string | null | undefined, email: string): string {
  const address = clean(email);
  const n = clean(name ?? "").replace(/\s+/g, " ");
  if (!n) return address;
  if (/^[\x20-\x7e]*$/.test(n)) return `"${n.replace(/(["\\])/g, "\\$1")}" <${address}>`;
  return `${encodeHeader(n)} <${address}>`;
}

export function replySubject(subject: string | null | undefined): string {
  const s = clean(subject ?? "");
  if (!s) return "Re: your email";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * Check 43 P5: subjects website form robots write (Squarespace, Wix, WPForms, Contact Form 7,
 * Jobber, Housecall Pro…). A homeowner never wrote them, so "Re: <that>" reads like spam.
 */
const FORM_ROBOT_SUBJECT =
  /form submission|new submission|new (form )?entry|new (lead|message|inquiry|enquiry|request) from|contact form|website (form|inquiry|enquiry)|request a quote/i;

/**
 * Check 43 P5: the subject of a reply that goes to a form lead's Reply-To address. A robot's
 * subject becomes "Your request to <business>" ("Your request" with no name); anything a person
 * could have written keeps "Re: <subject>".
 */
export function formReplySubject(
  original: string | null | undefined,
  businessName: string | null | undefined,
): string {
  const s = clean(original ?? "");
  if (!FORM_ROBOT_SUBJECT.test(s)) return replySubject(s);
  const name = clean(businessName ?? "").replace(/\s+/g, " ");
  return name ? `Your request to ${name}` : "Your request";
}

/** Check 43 P6: HTML-escape every character that means something in HTML. */
const escapeHtml = (v: string) =>
  v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/**
 * Check 43 P6: the reply's text as HTML, made mechanically so classic Outlook ("Remove extra
 * line breaks in plain text messages") can't join a signature into one line. Escaped text,
 * each line break a <br>, blank lines a paragraph break, in one plain <div>. No links, images,
 * colours or tracking: URLs stay text (mail apps link them). Never logged.
 */
export function textToHtml(text: string): string {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.replace(/^\n+|\n+$/g, ""))
    .filter((p) => p.length > 0)
    .map((p) => `<p>${p.split("\n").map(escapeHtml).join("<br>")}</p>`);
  return `<div dir="auto" style="font-family:inherit">${paragraphs.join("")}</div>`;
}

const base64Lines = (v: string) =>
  Buffer.from(v, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");

/** A MIME boundary that appears in neither part (base64 can't hold "_" or ".", but check). */
function boundaryFor(parts: string[]): string {
  for (;;) {
    const b = `=_sa_${randomBytes(12).toString("hex")}`;
    if (!parts.some((p) => p.includes(b))) return b;
  }
}

export function buildReplyMime(m: ReplyMime): string {
  const plain = base64Lines(m.body.replace(/\r?\n/g, "\r\n"));
  const html = base64Lines(textToHtml(m.body));
  const boundary = boundaryFor([plain, html]);
  const headers = [
    `From: ${formatAddress(m.fromName, m.from)}`,
    `To: ${clean(m.to)}`,
    `Subject: ${encodeHeader(m.subject)}`,
    "MIME-Version: 1.0",
    // Check 43 P6: the plain text exactly as before, plus the same text as HTML.
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const inReplyTo = m.inReplyTo ? clean(m.inReplyTo) : null;
  if (inReplyTo) {
    headers.push(`In-Reply-To: ${inReplyTo}`);
    const refs = [m.references ? clean(m.references) : "", inReplyTo].filter(Boolean).join(" ");
    headers.push(`References: ${refs}`);
  }
  const part = (type: string, body: string) =>
    [
      `--${boundary}`,
      `Content-Type: ${type}; charset="UTF-8"`,
      "Content-Transfer-Encoding: base64",
      "",
      body,
    ].join("\r\n");
  return [
    headers.join("\r\n"),
    "",
    part("text/plain", plain),
    part("text/html", html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
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
