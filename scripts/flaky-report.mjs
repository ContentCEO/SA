// Check 31 P8: list the e2e tests that passed only on a retry ("flaky" in Playwright's JSON
// report), with their file and project (mobile or desktop), as Markdown for the job summary.
// Usage: node scripts/flaky-report.mjs playwright-results.json >> "$GITHUB_STEP_SUMMARY"
import { existsSync, readFileSync } from "node:fs";

/** Every flaky test in a Playwright JSON report, as "file › title (project)". */
export function flakyTests(report) {
  const out = [];
  const visit = (suite, file) => {
    const here = suite.file ?? file;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (test.status === "flaky")
          out.push(`${spec.file ?? here} › ${spec.title} (${test.projectName ?? "?"})`);
      }
    }
    for (const child of suite.suites ?? []) visit(child, here);
  };
  for (const suite of report.suites ?? []) visit(suite, suite.file);
  return out;
}

export function summary(flaky) {
  if (!flaky.length) return "### Flaky e2e tests\n\nNone: every test passed on its first try.\n";
  return `### Flaky e2e tests\n\nThese passed only on a retry. Look at them before they fail for real:\n\n${flaky.map((t) => `- ${t}`).join("\n")}\n`;
}

if (process.argv[1]?.endsWith("flaky-report.mjs")) {
  const path = process.argv[2] ?? "playwright-results.json";
  if (!existsSync(path)) {
    console.log("### Flaky e2e tests\n\nNo Playwright report (the e2e step didn't run).\n");
  } else {
    console.log(summary(flakyTests(JSON.parse(readFileSync(path, "utf8")))));
  }
}
