/**
 * CI (Check 30 P2): this branch's drizzle/meta/_journal.json must be the base branch's journal
 * unchanged, plus new entries at the end. Usage: tsx scripts/check-journal.ts <base journal path>
 */
import { readFileSync } from "node:fs";
import {
  appendOnlyProblems,
  journalProblems,
  readJournal,
  type JournalEntry,
} from "./migrate-guard";

const basePath = process.argv[2];
if (!basePath) {
  console.error("Usage: tsx scripts/check-journal.ts <base _journal.json>");
  process.exit(1);
}
const base = (JSON.parse(readFileSync(basePath, "utf8")) as { entries: JournalEntry[] }).entries;
const head = readJournal("drizzle");
const problems = [...appendOnlyProblems(base, head), ...journalProblems(head)];
if (problems.length) {
  for (const p of problems) console.error(p);
  process.exit(1);
}
console.log(
  `Migration journal OK: ${head.length - base.length} new entr${head.length - base.length === 1 ? "y" : "ies"}.`,
);
