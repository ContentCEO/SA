import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { blockingAdvisories, parseAllowList } from "../../scripts/audit-check";

/** Check 26 P11: CI fails on a new high advisory in production dependencies. */
describe("the dependency audit", () => {
  const audit = {
    advisories: {
      "1": { github_advisory_id: "GHSA-aaaa-bbbb-cccc", severity: "high", module_name: "braces" },
      "2": { github_advisory_id: "GHSA-dddd-eeee-ffff", severity: "moderate", module_name: "x" },
      "3": { github_advisory_id: "GHSA-gggg-hhhh-iiii", severity: "critical", module_name: "y" },
    },
  };

  it("a high or critical advisory blocks; moderate ones don't", () => {
    expect(blockingAdvisories(audit, new Set())).toEqual([
      "GHSA-aaaa-bbbb-cccc (braces, high)",
      "GHSA-gggg-hhhh-iiii (y, critical)",
    ]);
  });

  it("the allow list excuses only the ids it names, each with a date and a reason", () => {
    const allowed = parseAllowList(
      "# comment\nGHSA-aaaa-bbbb-cccc 2026-10-18 no fixed version yet; build-time only\n",
    );
    expect(blockingAdvisories(audit, allowed)).toEqual(["GHSA-gggg-hhhh-iiii (y, critical)"]);
    expect(() => parseAllowList("GHSA-aaaa-bbbb-cccc\n")).toThrow(/line 1/);
  });

  it("the checked-in allow list parses, and CI runs the audit right after install", () => {
    expect(() => parseAllowList(readFileSync(".github/audit-allow.txt", "utf8"))).not.toThrow();
    const ci = readFileSync(".github/workflows/ci.yml", "utf8");
    const install = ci.indexOf("pnpm install --frozen-lockfile");
    const auditStep = ci.indexOf("pnpm exec tsx scripts/audit-check.ts");
    expect(auditStep).toBeGreaterThan(install);
    expect(auditStep).toBeLessThan(ci.indexOf("pnpm lint"));
    expect(readFileSync(".github/dependabot.yml", "utf8")).toMatch(/package-ecosystem: npm/);
  });

  it("shadcn (a build-time CLI) is a dev dependency", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies.shadcn).toBeUndefined();
    expect(pkg.devDependencies.shadcn).toBeDefined();
  });
});
