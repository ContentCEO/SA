/**
 * Check 26 P11: CI's dependency audit. Runs `pnpm audit --prod --json` and fails on any high or
 * critical advisory that isn't on the reviewed exception list, .github/audit-allow.txt (one per
 * line: "<GHSA id> <YYYY-MM-DD> <reason>"; # starts a comment). Use the list only for an
 * advisory with no fixed version yet, and remove the line once one ships.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

type Advisory = { github_advisory_id?: string; severity?: string; module_name?: string };
export type AuditJson = { advisories?: Record<string, Advisory> };

/** The allowed advisory ids. A line without an id, a date and a reason is an error. */
export function parseAllowList(text: string): Set<string> {
  const ids = new Set<string>();
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = /^(GHSA(?:-[0-9a-z]{4}){3})\s+(\d{4}-\d{2}-\d{2})\s+(\S.*)$/.exec(line);
    if (!m) throw new Error(`.github/audit-allow.txt line ${i + 1}: "<GHSA id> <date> <reason>"`);
    ids.add(m[1]!);
  }
  return ids;
}

/** High and critical advisories that aren't allowed, as "GHSA-… (package, severity)". */
export function blockingAdvisories(audit: AuditJson, allowed: Set<string>): string[] {
  return Object.values(audit.advisories ?? {})
    .filter((a) => a.severity === "high" || a.severity === "critical")
    .filter((a) => !allowed.has(a.github_advisory_id ?? ""))
    .map((a) => `${a.github_advisory_id ?? "unknown"} (${a.module_name ?? "?"}, ${a.severity})`)
    .sort();
}

function main() {
  let out: string;
  try {
    out = execFileSync("pnpm", ["audit", "--prod", "--json"], { encoding: "utf8" });
  } catch (err) {
    // pnpm audit exits non-zero when it finds anything; its JSON is still on stdout.
    out = String((err as { stdout?: unknown }).stdout ?? "");
  }
  const audit = JSON.parse(out) as AuditJson;
  const allowed = parseAllowList(readFileSync(".github/audit-allow.txt", "utf8"));
  const blocking = blockingAdvisories(audit, allowed);
  if (blocking.length) {
    console.error(
      `High or critical advisories in production dependencies:\n${blocking.join("\n")}`,
    );
    console.error(
      "Update the package, or (only if no fix exists yet) add it to .github/audit-allow.txt.",
    );
    process.exit(1);
  }
  console.log("No high or critical advisories in production dependencies (beyond the allow list).");
}

if (process.argv[1]?.endsWith("audit-check.ts")) main();
