import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Wave 3, "Legal text, one release": the code halves of the legal prompts. The documents
 * themselves change only in the legal release (docs/LEGAL-RELEASE.md); these checks hold the
 * mirrors and the screens to the code now.
 */

/** Markdown wraps lines; compare text with the line breaks and runs of spaces collapsed. */
const flat = (s: string) => s.replace(/\s+/g, " ");

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?)$/.test(p) ? [p] : [];
  });

describe("Check 27 P5: the Limited Use statement uses Google's terms", () => {
  it("docs/google-verification.md states the AI-training commitment with Google's words", () => {
    const doc = flat(readFileSync("docs/google-verification.md", "utf8"));
    expect(doc).toContain(
      "whether raw, combined, anonymized or derived from it, to develop, improve or train generalized or non-personalized AI or machine-learning models",
    );
    expect(doc).toContain(
      "The writing-style description we make from an owner's sent mail is used only for that owner's own drafts.",
    );
    expect(doc).not.toContain("never used to train AI models (Anthropic");
  });
});

describe("Check 27 P9: the connect screen names the same places as the policy", () => {
  it("says the email is stored on our servers and read by Anthropic's AI, never trained on", () => {
    const page = flat(readFileSync("src/app/(app)/connect/page.tsx", "utf8"));
    expect(page).toContain(
      "Share your email. It&apos;s stored on our own servers in the US, and the only outside company that reads it is Anthropic&apos;s AI, to sort and draft. It&apos;s never used to train AI.",
    );
    expect(page).not.toContain("only outside service");
    // The policy says the same: one outside service for the text, stored by us in the US.
    const policy = flat(readFileSync("docs/privacy-policy.md", "utf8"));
    expect(policy).toContain("Email text is sent to one outside service, Anthropic");
    expect(policy).toContain("Squared Away runs in the United States.");
  });
});

describe("Check 27 P8: what the browser keeps is in the policy", () => {
  const policy = flat(readFileSync("docs/privacy-policy.md", "utf8"));
  const uses = files("src").filter((f) =>
    /\b(localStorage|sessionStorage)\b/.test(readFileSync(f, "utf8")),
  );

  it("the app does keep things in the browser (the scan isn't empty)", () => {
    expect(uses.length).toBeGreaterThanOrEqual(5);
    expect(uses).toContain(join("src", "lib", "landing-source.ts"));
    expect(uses).toContain(join("src", "lib", "offline-intents.ts"));
  });

  it("the policy names the browser's storage (offline approvals and the queue copy)", () => {
    expect(policy).toContain("in the browser's storage");
    expect(policy).toContain("signing out deletes them");
  });
});
