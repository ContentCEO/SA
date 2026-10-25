import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { assertPreviewSafe } from "@/config/environment-guard";

/**
 * AES-256-GCM for secrets at rest (Gmail refresh tokens, the Stripe webhook secret).
 * Format: "v1.<iv b64url>.<auth tag b64url>.<ciphertext b64url>".
 *
 * Check 26 P7: the key can be replaced without disconnecting anyone. New secrets are always
 * sealed with TOKEN_ENCRYPTION_KEY; a secret that doesn't open with it (GCM's auth tag fails) is
 * tried with TOKEN_ENCRYPTION_KEY_PREVIOUS when that is set. `pnpm reseal:secrets` then re-seals
 * every stored secret with the current key, and the previous one can go (docs/SETUP.md).
 */
const VERSION = "v1";
const IV_BYTES = 12;

function loadKey(raw = process.env.TOKEN_ENCRYPTION_KEY, name = "TOKEN_ENCRYPTION_KEY"): Buffer {
  if (!raw) throw new Error(`${name} is not set. See .env.example.`);
  // Check 26 P2: a preview holding production's key (or database) never decrypts anything.
  assertPreviewSafe({ ...process.env, TOKEN_ENCRYPTION_KEY: raw });
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded.`);
  return key;
}

/** Check 26 P7: the key being replaced, while `pnpm reseal:secrets` moves everything off it. */
function previousKey(): Buffer | null {
  const raw = process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  return raw ? loadKey(raw, "TOKEN_ENCRYPTION_KEY_PREVIOUS") : null;
}

export function encryptSecret(plaintext: string, rawKey?: string): string {
  const key = loadKey(rawKey);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv, tag, ciphertext]
    .map((p) => (typeof p === "string" ? p : p.toString("base64url")))
    .join(".");
}

function open(payload: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = payload.split(".");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) {
    throw new Error("Unrecognized encrypted secret format.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Opens a sealed secret. With `rawKey`, only that key. Otherwise the current key, then (only
 * when its auth tag fails and TOKEN_ENCRYPTION_KEY_PREVIOUS is set) the previous one.
 */
export function decryptSecret(payload: string, rawKey?: string): string {
  if (rawKey !== undefined) return open(payload, loadKey(rawKey));
  const current = loadKey(); // a missing or malformed key is an error, never a fallback
  try {
    return open(payload, current);
  } catch (err) {
    const previous = previousKey();
    if (!previous || (err instanceof Error && err.message.startsWith("Unrecognized"))) throw err;
    return open(payload, previous);
  }
}

/** Check 26 P7: whether a sealed secret opens with the current key alone (no re-seal needed). */
export function sealedWithCurrentKey(payload: string): boolean {
  const current = loadKey();
  try {
    open(payload, current);
    return true;
  } catch {
    return false;
  }
}
