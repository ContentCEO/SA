import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Check 19 P6: Twilio signs each callback with the account's auth token —
 * Base64(HMAC-SHA1(token, url + every POST parameter as name + value, sorted by name)) in
 * X-Twilio-Signature. Compared in constant time; anything missing is a mismatch.
 */
export function twilioSignature(token: string, url: string, params: Record<string, string>) {
  const data =
    url +
    Object.keys(params)
      .sort()
      .map((k) => k + params[k])
      .join("");
  return createHmac("sha1", token).update(data, "utf8").digest("base64");
}

export function twilioSignatureOk(
  token: string | undefined | null,
  url: string,
  params: Record<string, string>,
  signature: string | null | undefined,
): boolean {
  if (!token || !signature) return false;
  const want = Buffer.from(twilioSignature(token, url, params));
  const got = Buffer.from(signature);
  return want.length === got.length && timingSafeEqual(want, got);
}
