import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Plan M8 A24: the *-rules files are pure. They (and everything they import, all the way
 * down) never load "server-only" or the database, so they can be used from pure code,
 * tests and client components alike. Type-only imports are erased and allowed.
 */
const SRC = resolve("src");
const SERVER = join(SRC, "server");

/** Value imports and re-exports of a file (skips `import type` / `export type`). */
function valueImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  const from = /^\s*(?:import|export)\s+(?!type[\s{])[^;]*?\sfrom\s+["']([^"']+)["']/gm;
  const bare = /^\s*import\s+["']([^"']+)["']/gm;
  for (const re of [from, bare]) for (const m of text.matchAll(re)) out.push(m[1]!);
  return out;
}

function resolveLocal(spec: string, fromFile: string): string | null {
  const base = spec.startsWith("@/")
    ? join(SRC, spec.slice(2))
    : spec.startsWith(".")
      ? resolve(dirname(fromFile), spec)
      : null;
  if (!base) return null;
  for (const f of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), base])
    if (existsSync(f) && f.match(/\.tsx?$/)) return f;
  throw new Error(`can't resolve ${spec} from ${fromFile}`);
}

/** Every forbidden value import reachable from `entry`, as "file → specifier". */
function forbiddenFrom(entry: string): string[] {
  const seen = new Set<string>();
  const bad: string[] = [];
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of valueImports(file)) {
      if (spec === "server-only" || spec === "@/db" || spec.startsWith("@/db/"))
        bad.push(`${relative(SRC, file)} → ${spec}`);
      const local = resolveLocal(spec, file);
      if (local) queue.push(local);
    }
  }
  return bad;
}

const rulesFiles = readdirSync(SERVER)
  .filter((f) => f.endsWith("-rules.ts"))
  .map((f) => join(SERVER, f));

describe("*-rules files are pure (A24)", () => {
  it("finds the rules files, including M8's", () => {
    const names = rulesFiles.map((f) => f.split("/").pop());
    for (const f of [
      "snooze-rules.ts",
      "scorecard-rules.ts",
      "business-hours-rules.ts",
      "monthly-rules.ts",
    ])
      expect(names).toContain(f);
  });

  it.each(rulesFiles.map((f) => [relative(SRC, f), f]))(
    "%s never imports server-only or the database",
    (_name, file) => {
      expect(forbiddenFrom(file)).toEqual([]);
    },
  );

  it("the checker itself catches a server-only import", () => {
    expect(forbiddenFrom(join(SERVER, "digest.ts")).length).toBeGreaterThan(0);
  });
});
