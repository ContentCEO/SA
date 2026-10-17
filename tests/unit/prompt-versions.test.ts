import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { ACTIVE } from "@/ai/prompts/registry";

/**
 * Check 50 P2: prompts are versioned with one new file per change, and the stored prompt version
 * on a draft or classification must say which instructions wrote it. Several builders writing
 * "draft.v7" side by side would break that. This checks src/ai/prompts against the registry.
 */

const PROMPTS = "src/ai/prompts";
const FILE = /^([a-z][a-z-]*)\.v(\d+)\.ts$/;

/** Registry key ↔ file prefix ("editTone" ↔ "edit-tone"). */
const fileKind = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

type PromptFile = { file: string; kind: string; n: number; version: string | null };

function promptFiles(dir: string): PromptFile[] {
  return readdirSync(dir)
    .map((file) => [file, file.match(FILE)] as const)
    .filter(([, m]) => m)
    .map(([file, m]) => {
      const text = readFileSync(join(dir, file), "utf8");
      const version = text.match(/export const [A-Z_]+_PROMPT_VERSION = "([^"]+)"/)?.[1] ?? null;
      return { file, kind: m![1]!, n: Number(m![2]), version };
    });
}

/** Every problem with a prompts folder, given the registry it should match. */
function versionProblems(dir: string, active: Record<string, string>): string[] {
  const files = promptFiles(dir);
  const problems: string[] = [];
  const byVersion = new Map<string, string>();
  for (const f of files) {
    const expected = `${f.kind}.v${f.n}`;
    if (f.version !== expected) {
      problems.push(`${f.file} declares ${f.version ?? "no version"}, expected "${expected}"`);
    }
    if (f.version) {
      const other = byVersion.get(f.version);
      if (other) problems.push(`${other} and ${f.file} both claim "${f.version}"`);
      byVersion.set(f.version, f.file);
    }
  }
  const kinds = [...new Set(files.map((f) => f.kind))];
  for (const kind of kinds) {
    const ns = files.filter((f) => f.kind === kind).map((f) => f.n);
    const max = Math.max(...ns);
    for (let n = 1; n <= max; n++) {
      if (!ns.includes(n)) problems.push(`${kind}.v${n} is missing (versions must have no gaps)`);
    }
    const key = Object.keys(active).find((k) => fileKind(k) === kind);
    if (!key) problems.push(`${kind} has no entry in ACTIVE`);
    else if (active[key] !== `${kind}.v${max}`) {
      problems.push(`ACTIVE.${key} is "${active[key]}", the newest file is ${kind}.v${max}`);
    }
  }
  for (const key of Object.keys(active)) {
    if (!kinds.includes(fileKind(key))) problems.push(`ACTIVE.${key} has no prompt files`);
  }
  return problems;
}

function codeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return codeFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe("prompt versions (src/ai/prompts)", () => {
  it("finds the prompt files", () => {
    expect(promptFiles(PROMPTS).length).toBeGreaterThanOrEqual(20);
  });

  it("each file's constant matches its name, none repeat, no gaps, ACTIVE is the newest", () => {
    expect(versionProblems(PROMPTS, ACTIVE)).toEqual([]);
  });

  it("code that records a version imports it from the ACTIVE file", () => {
    // Otherwise a stored version could name one file's instructions while another's ran.
    const wrong: string[] = [];
    const files = [...codeFiles("src"), ...codeFiles("tests/evals")].filter(
      (f) => !f.startsWith(PROMPTS),
    );
    for (const path of files) {
      const text = readFileSync(path, "utf8");
      for (const m of text.matchAll(
        /import\s*\{([^}]*)\}\s*from\s*"(?:@\/ai\/prompts\/|\.\/prompts\/)([a-z-]+\.v\d+)"/g,
      )) {
        for (const name of m[1]!.matchAll(/\b([A-Z_]+)_PROMPT_VERSION\b/g)) {
          const key = Object.keys(ACTIVE).find(
            (k) => fileKind(k).replace(/-/g, "_").toUpperCase() === name[1],
          ) as keyof typeof ACTIVE | undefined;
          if (!key || ACTIVE[key] !== m[2]) {
            wrong.push(`${relative(".", path)} imports ${name[0]} from ${m[2]}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("catches two files claiming the same version, and a skipped version (fixture folder)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sa-prompts-"));
    try {
      const write = (file: string, version: string) =>
        writeFileSync(join(dir, file), `export const DRAFT_PROMPT_VERSION = "${version}";\n`);
      for (let n = 1; n <= 7; n++) write(`draft.v${n}.ts`, `draft.v${n}`);
      expect(versionProblems(dir, { draft: "draft.v7" })).toEqual([]);

      // A second builder's "draft.v7" saved under the next free name.
      write("draft.v8.ts", "draft.v7");
      const dupes = versionProblems(dir, { draft: "draft.v8" });
      expect(dupes).toContain('draft.v7.ts and draft.v8.ts both claim "draft.v7"');
      expect(dupes).toContain('draft.v8.ts declares draft.v7, expected "draft.v8"');

      rmSync(join(dir, "draft.v8.ts"));
      write("draft.v9.ts", "draft.v9");
      const gaps = versionProblems(dir, { draft: "draft.v7" });
      expect(gaps).toContain("draft.v8 is missing (versions must have no gaps)");
      expect(gaps).toContain('ACTIVE.draft is "draft.v7", the newest file is draft.v9');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
