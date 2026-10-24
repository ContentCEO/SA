import { parseAddressList } from "../address";

/**
 * Plan #49: read back the parts of a reply WE built (src/mailbox/mime.ts `buildReplyMime`), so
 * a draft can be updated in place with Graph's JSON fields (Graph's update takes no MIME). Only
 * our own format is understood: headers, then a multipart/alternative with a base64 text/plain
 * and a base64 text/html part. Anything else throws (never a half-read update). Pure.
 */
export type OwnMimeParts = {
  subject: string;
  to: { name?: string; email: string }[];
  cc: { name?: string; email: string }[];
  text: string;
  html: string;
};

/** RFC 2047 B-encoded UTF-8 words (what encodeHeader writes), folded lines joined. */
export function decodeHeaderValue(v: string): string {
  return v
    .replace(/\r\n[ \t]/g, " ")
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/gi, (_, b64: string) =>
      Buffer.from(b64, "base64").toString("utf8"),
    );
}

function headersOf(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block.replace(/\r\n[ \t]/g, " ").split("\r\n")) {
    const i = line.indexOf(":");
    if (i > 0) out.set(line.slice(0, i).trim().toLowerCase(), line.slice(i + 1).trim());
  }
  return out;
}

export function parseOwnMime(mime: string): OwnMimeParts {
  const split = mime.indexOf("\r\n\r\n");
  if (split < 0) throw new Error("Not our MIME.");
  const headers = headersOf(mime.slice(0, split));
  const boundary = headers.get("content-type")?.match(/boundary="([^"]+)"/)?.[1];
  if (!boundary) throw new Error("Not our MIME.");
  const parts = mime
    .slice(split + 4)
    .split(`--${boundary}`)
    .map((p) => p.replace(/^\r\n/, ""))
    .filter((p) => p && !p.startsWith("--"));
  const body = (type: string) => {
    for (const p of parts) {
      const at = p.indexOf("\r\n\r\n");
      if (at < 0) continue;
      const h = headersOf(p.slice(0, at));
      if (!h.get("content-type")?.toLowerCase().startsWith(type)) continue;
      if (h.get("content-transfer-encoding")?.toLowerCase() !== "base64") break;
      return Buffer.from(p.slice(at + 4).replace(/\s+/g, ""), "base64").toString("utf8");
    }
    throw new Error("Not our MIME.");
  };
  return {
    subject: decodeHeaderValue(headers.get("subject") ?? ""),
    to: parseAddressList(decodeHeaderValue(headers.get("to") ?? "")),
    cc: parseAddressList(decodeHeaderValue(headers.get("cc") ?? "")),
    text: body("text/plain").replace(/\r\n/g, "\n"),
    html: body("text/html"),
  };
}

/** Gmail's raw (base64url) → standard base64, which Graph's MIME upload takes. */
export function rawToBase64(raw: string): string {
  return Buffer.from(raw, "base64url").toString("base64");
}

export function rawToMime(raw: string): string {
  return Buffer.from(raw, "base64url").toString("utf8");
}
