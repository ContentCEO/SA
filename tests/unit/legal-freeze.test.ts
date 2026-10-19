import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FROZEN_DOCS,
  LEGAL_BASE_BRANCH,
  frozenMessage,
  legalEditsAllowed,
  legalFreezeVerdict,
  termsVersionIn,
} from "../support/legal-freeze";

/**
 * Check 50 P5: owners agree to the terms once per release, not once per review prompt. This
 * test fails any branch other than `claude/legal-*` (the release) or `integrate-*` (the
 * integrator's merge) that changes docs/terms.md, docs/privacy-policy.md or TERMS_VERSION since
 * it left the base branch. The wording such a branch needs goes in docs/notes/legal-<branch>.md
 * (docs/LEGAL-RELEASE.md).
 */

function git(...args: string[]): string | null {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The branch under test: GitHub's PR head, else the checked-out branch (null when detached). */
function currentBranch(): string | null {
  const fromCi = process.env.GITHUB_HEAD_REF?.trim();
  if (fromCi) return fromCi;
  const local = git("rev-parse", "--abbrev-ref", "HEAD");
  return local && local !== "HEAD" ? local : null;
}

/** Where this branch left the base: the first base ref git knows about. */
function mergeBase(): string | null {
  const refs = [
    LEGAL_BASE_BRANCH,
    `origin/${LEGAL_BASE_BRANCH}`,
    ...(process.env.GITHUB_BASE_REF ? [`origin/${process.env.GITHUB_BASE_REF}`] : []),
  ];
  for (const ref of refs) {
    const base = git("merge-base", "HEAD", ref);
    if (base) return base;
  }
  return null;
}

describe("the legal freeze (Check 50 P5)", () => {
  it("on this branch: the documents and TERMS_VERSION are as they were on the base", () => {
    const branch = currentBranch();
    if (!branch) {
      console.warn("legal-freeze: no branch name (detached HEAD, no GITHUB_HEAD_REF); skipped.");
      return;
    }
    if (legalEditsAllowed(branch)) {
      console.warn(`legal-freeze: "${branch}" may change the legal text; skipped.`);
      return;
    }
    const base = mergeBase();
    if (!base) {
      console.warn(
        `legal-freeze: can't find where "${branch}" left ${LEGAL_BASE_BRANCH} (a shallow checkout? ` +
          "fetch the base branch, or use fetch-depth: 0 in CI); skipped.",
      );
      return;
    }
    // Committed and uncommitted changes alike: `git diff <commit>` compares to the working tree.
    const changedDocs = (git("diff", "--name-only", base, "--", ...FROZEN_DOCS) ?? "")
      .split("\n")
      .filter(Boolean);
    const verdict = legalFreezeVerdict({
      branch,
      changedDocs,
      versionBefore: termsVersionIn(git("show", `${base}:src/config/legal.ts`)),
      versionAfter: termsVersionIn(readFileSync("src/config/legal.ts", "utf8")),
    });
    if (verdict.kind === "frozen") throw new Error(frozenMessage(branch, verdict.problems));
    expect(verdict.kind).toBe("ok");
  });

  it("fails a working branch that changed a policy file or the version", () => {
    expect(
      legalFreezeVerdict({
        branch: "w3-growth",
        changedDocs: ["docs/privacy-policy.md"],
        versionBefore: "2026-10-16",
        versionAfter: "2026-10-16",
      }),
    ).toEqual({ kind: "frozen", problems: ["docs/privacy-policy.md changed"] });
    expect(
      legalFreezeVerdict({
        branch: "claude/wave-3-emails",
        changedDocs: [],
        versionBefore: "2026-10-16",
        versionAfter: "2026-10-16.2",
      }),
    ).toEqual({
      kind: "frozen",
      problems: ["TERMS_VERSION changed (2026-10-16 → 2026-10-16.2)"],
    });
    expect(
      legalFreezeVerdict({
        branch: "w3-growth",
        changedDocs: ["docs/terms.md", "docs/privacy-policy.md"],
        versionBefore: "2026-10-16",
        versionAfter: null,
      }),
    ).toMatchObject({ kind: "frozen" });
    const msg = frozenMessage("w3-growth", ["docs/terms.md changed"]);
    expect(msg).toContain("docs/notes/legal-w3-growth.md");
    expect(msg).toContain("docs/LEGAL-RELEASE.md");
  });

  it("passes a working branch that left them alone", () => {
    expect(
      legalFreezeVerdict({
        branch: "w3-growth",
        changedDocs: [],
        versionBefore: "2026-10-16",
        versionAfter: "2026-10-16",
      }),
    ).toEqual({ kind: "ok" });
  });

  it("the release branch and the integrator's branch may change them", () => {
    for (const branch of [
      "claude/legal-2026-11-01",
      "integrate-w3",
      "integrate-legal-2026-11-01",
      LEGAL_BASE_BRANCH,
      "main",
    ]) {
      expect(legalEditsAllowed(branch), branch).toBe(true);
      expect(
        legalFreezeVerdict({
          branch,
          changedDocs: ["docs/terms.md"],
          versionBefore: "2026-10-16",
          versionAfter: "2026-11-01",
        }),
      ).toEqual({ kind: "exempt", branch });
    }
    for (const branch of ["claude/legal", "legal-2026-11-01", "w3-legal", "integrated-w3"])
      expect(legalEditsAllowed(branch), branch).toBe(false);
  });

  it("reads TERMS_VERSION from the config source", () => {
    expect(termsVersionIn('export const TERMS_VERSION = "2026-10-16";')).toBe("2026-10-16");
    expect(termsVersionIn('export const TERMS_VERSION = "2026-10-16.2";')).toBe("2026-10-16.2");
    expect(termsVersionIn(null)).toBeNull();
    expect(termsVersionIn("export const OTHER = 1;")).toBeNull();
    expect(termsVersionIn(readFileSync("src/config/legal.ts", "utf8"))).toMatch(
      /^\d{4}-\d{2}-\d{2}/,
    );
  });
});
