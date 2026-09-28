import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

const key = randomBytes(32).toString("base64");

describe("token encryption", () => {
  it("round-trips a refresh token", () => {
    const token = "1//0gExampleRefreshToken-_abc";
    const sealed = encryptSecret(token, key);
    expect(sealed).not.toContain(token);
    expect(sealed.startsWith("v1.")).toBe(true);
    expect(decryptSecret(sealed, key)).toBe(token);
  });

  it("uses a fresh IV every time", () => {
    expect(encryptSecret("same", key)).not.toBe(encryptSecret("same", key));
  });

  it("rejects tampered ciphertext", () => {
    const sealed = encryptSecret("secret", key);
    const parts = sealed.split(".");
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0] = ct[0]! ^ 0xff;
    parts[3] = ct.toString("base64url");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
  });

  it("rejects the wrong key", () => {
    const sealed = encryptSecret("secret", key);
    expect(() => decryptSecret(sealed, randomBytes(32).toString("base64"))).toThrow();
  });

  it("refuses a key that isn't 32 bytes", () => {
    expect(() => encryptSecret("x", Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
