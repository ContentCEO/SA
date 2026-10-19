import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { changesSince, parseLegalChanges, type LegalChange } from "./legal-changes-rules";

/** Check 27 P3: the documents' changelog, read from the repo like the documents themselves. */
export async function loadLegalChanges(): Promise<LegalChange[]> {
  const raw = await readFile(path.join(process.cwd(), "docs", "legal-changes.md"), "utf8");
  return parseLegalChanges(raw);
}

/** What someone who agreed to `agreedVersion` hasn't seen yet (newest first). */
export async function legalChangesSince(agreedVersion: string | null): Promise<LegalChange[]> {
  return changesSince(await loadLegalChanges(), agreedVersion);
}
