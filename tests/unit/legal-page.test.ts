import { afterEach, describe, expect, it, vi } from "vitest";
import { loadLegalDoc, writtenContactLine } from "@/components/marketing/legal-page";
import { siteConfig } from "@/config/site";
import { NO_SUPPORT_EMAIL_LINE, supportEmailWarning } from "@/server/admin-mailbox-rules";

/**
 * Check 27 P2: a data request always has a written way in. The Contact block of /privacy and
 * /terms ends with the support email when SUPPORT_EMAIL is set, and with a text link to the
 * business phone when it isn't; /admin's System box says when the email is missing.
 */

afterEach(() => vi.unstubAllEnvs());

describe("the Contact block's written channel (Check 27 P2)", () => {
  it("SUPPORT_EMAIL set: the email line, no text line", async () => {
    vi.stubEnv("SUPPORT_EMAIL", " help@example.com ");
    for (const file of ["privacy-policy.md", "terms.md"] as const) {
      const doc = await loadLegalDoc(file);
      expect(doc).toContain("Email: [help@example.com](mailto:help@example.com)");
      expect(doc).not.toContain("Text:");
    }
  });

  it("SUPPORT_EMAIL unset or blank: a text link to the business phone, as a hard-break line", async () => {
    for (const value of [undefined, "", "   "]) {
      vi.stubEnv("SUPPORT_EMAIL", value);
      for (const file of ["privacy-policy.md", "terms.md"] as const) {
        const doc = await loadLegalDoc(file);
        expect(doc).not.toContain("Email:");
        expect(doc).toContain(
          `Phone: [${siteConfig.phone}](tel:${siteConfig.phone})\\\nText: [${siteConfig.phone}](sms:+19782019763) (texts get a written reply)`,
        );
        expect(doc).not.toContain("{{");
      }
    }
  });

  it("the line itself", () => {
    expect(writtenContactLine("help@example.com")).toBe(
      "Email: [help@example.com](mailto:help@example.com)",
    );
    expect(writtenContactLine(undefined)).toBe(
      "Text: [978-201-9763](sms:+19782019763) (texts get a written reply)",
    );
  });
});

describe("/admin warns when the support email is missing (Check 27 P2)", () => {
  it("set: nothing", () => {
    expect(
      supportEmailWarning({ SUPPORT_EMAIL: "help@example.com", VERCEL_ENV: "production" }),
    ).toBeNull();
  });

  it("missing in production: the line, and the box inverts", () => {
    expect(supportEmailWarning({ VERCEL_ENV: "production" })).toEqual({
      line: NO_SUPPORT_EMAIL_LINE,
      inverts: true,
    });
    expect(supportEmailWarning({ SUPPORT_EMAIL: "  ", VERCEL_ENV: "production" })).toEqual({
      line: NO_SUPPORT_EMAIL_LINE,
      inverts: true,
    });
    expect(NO_SUPPORT_EMAIL_LINE).toBe(
      "No support email set. The privacy policy has no email for data requests.",
    );
  });

  it("missing on a preview or locally: the line, without inverting the box", () => {
    expect(supportEmailWarning({ VERCEL_ENV: "preview" })).toEqual({
      line: NO_SUPPORT_EMAIL_LINE,
      inverts: false,
    });
    expect(supportEmailWarning({})).toEqual({ line: NO_SUPPORT_EMAIL_LINE, inverts: false });
  });
});
