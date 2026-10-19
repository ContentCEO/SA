import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LEGAL_DOCS_SHA256 } from "@/config/legal";

/**
 * Check 27 P4: the documents can't change without a new version. LEGAL_DOCS_SHA256 is the hash
 * of docs/terms.md + "\n" + docs/privacy-policy.md; a legal release recomputes it together with
 * TERMS_VERSION (docs/LEGAL-RELEASE.md step 4).
 */
describe("LEGAL_DOCS_SHA256 (Check 27 P4)", () => {
  it("matches the documents in the repo", () => {
    const actual = createHash("sha256")
      .update(
        readFileSync("docs/terms.md", "utf8") +
          "\n" +
          readFileSync("docs/privacy-policy.md", "utf8"),
      )
      .digest("hex");
    expect(
      actual,
      "The terms or privacy policy changed: bump TERMS_VERSION and update LEGAL_DOCS_SHA256 " +
        `in src/config/legal.ts to "${actual}" (one legal release, docs/LEGAL-RELEASE.md).`,
    ).toBe(LEGAL_DOCS_SHA256);
    expect(LEGAL_DOCS_SHA256).toMatch(/^[0-9a-f]{64}$/);
  });
});
