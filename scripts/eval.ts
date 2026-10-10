/**
 * pnpm eval — run the prompt evaluation set against the live models.
 *   pnpm eval                    score and compare with tests/evals/baseline.json
 *   pnpm eval --update-baseline  record these scores as the new baseline (commit it)
 *   pnpm eval --no-drafts        classification only (cheaper)
 * Needs ANTHROPIC_API_KEY. Costs a dollar or two per full run. Run it before a
 * release or after any prompt change — not on every PR (Davi, 2026-10-09).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { EVAL_CASES } from "../tests/evals/cases";
import { PROMPT_VERSIONS, runEvals } from "../tests/evals/run";
import { regressions, table, type Baseline } from "../tests/evals/score";

const BASELINE = "tests/evals/baseline.json";

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY isn't set — evals call the real models.");
    process.exit(2);
  }
  const args = new Set(process.argv.slice(2));
  const base = JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
  const run = await runEvals(EVAL_CASES, {
    drafts: !args.has("--no-drafts"),
    onProgress: (d, t) => process.stderr.write(`\r${d}/${t}`),
  });
  process.stderr.write("\n");

  console.log(table(run.scores, base.scores));
  console.log(
    `\nTokens: ${run.tokens.input.toLocaleString()} in / ${run.tokens.output.toLocaleString()} out · est. cost $${run.costDollars.toFixed(2)}`,
  );
  const misses = run.results.filter((r) => r.draftProblems?.length);
  for (const m of misses) console.log(`draft ${m.id}: ${m.draftProblems!.join("; ")}`);

  if (args.has("--update-baseline")) {
    const next: Baseline = {
      recordedAt: new Date().toISOString(),
      promptVersions: PROMPT_VERSIONS,
      scores: run.scores,
    };
    writeFileSync(BASELINE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`\nBaseline updated — commit ${BASELINE}.`);
    return;
  }
  if (!base.scores) {
    console.log("\nNo baseline yet. Run `pnpm eval --update-baseline` once and commit it.");
    return;
  }
  const worse = regressions(run.scores, base.scores);
  if (worse.length) {
    console.error(`\nWorse than the baseline:\n  ${worse.join("\n  ")}`);
    process.exit(1);
  }
  console.log("\nNo regressions against the baseline.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
