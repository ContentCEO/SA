import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Outside review (2026-10-15): form-field edges were stone on paper, about 1.3:1. WCAG 1.4.11
 * asks for 3:1 against what's next to the edge: the field's own fill (every field is bg-paper)
 * and the surface it sits on (background or card). Checked in each look the theme defines.
 */
const css = readFileSync("src/styles/theme.css", "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

function block(selector: string): Map<string, string> {
  const at = css.indexOf(`${selector} {`);
  expect(at, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  return new Map(
    body
      .split(";")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("--"))
      .map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]),
  );
}

/** Resolve a token through the given scopes (innermost first). */
function resolve(token: string, scopes: Map<string, string>[]): string {
  for (const s of scopes) {
    const v = s.get(token);
    if (v === undefined) continue;
    const ref = v.match(/^var\((--[a-z0-9-]+)\)$/);
    if (ref) return resolve(ref[1], scopes);
    return v;
  }
  throw new Error(`unresolved ${token}`);
}

function luminance(hex: string): number {
  const n = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

const root = block(":root");
const LOOKS: [string, Map<string, string>[]][] = [
  ["normal", [root]],
  ["light card (.sa-light)", [block(".sa-light"), root]],
  ["sunlight", [block(':root:has([data-contrast="high"])'), root]],
  ["sunlight light card", [block(".sa-light"), block(':root:has([data-contrast="high"])'), root]],
  ["Growth mode", [block(':root[data-sa-theme="growth"]'), root]],
];

describe("form field edges are 3:1 or better", () => {
  for (const [name, scopes] of LOOKS) {
    it(name, () => {
      const input = resolve("--input", scopes);
      for (const against of ["--background", "--card"]) {
        const bg = resolve(against, scopes);
        expect(contrast(input, bg), `${name}: --input on ${against}`).toBeGreaterThanOrEqual(3);
      }
      if (name !== "Growth mode") {
        // Every field is bg-paper; in Growth mode the fields live in .sa-light cards.
        const paper = resolve("--sa-paper", scopes);
        expect(contrast(input, paper), `${name}: --input on paper`).toBeGreaterThanOrEqual(3);
      }
    });
  }

  it("the normal look uses slate, not stone", () => {
    expect(root.get("--input")).toBe("var(--sa-slate)");
  });
});

/**
 * Check 1 P5: every visible field in the source uses the slate edge (border-input). A plain
 * `border` is stone, the faint look. Scans each <input>, <select> and <textarea> tag (skipping
 * the ones that aren't drawn as a box: hidden, checkboxes and radios, the honeypots, the Growth
 * form's invisible checkbox overlay).
 */
function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx"))
    .map((f) => join(dir, f));
}

/** The attribute text of each field tag: up to the `>` that isn't inside braces or quotes. */
function fieldTags(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<(input|select|textarea)\b/g)) {
    let depth = 0;
    let quote: string | null = null;
    let i = m.index! + m[0].length;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    out.push(src.slice(m.index!, i));
  }
  return out;
}

describe("every visible field has the slate edge", () => {
  const files = tsxFiles("src");
  it("finds the fields", () => {
    expect(files.flatMap((f) => fieldTags(readFileSync(f, "utf8"))).length).toBeGreaterThan(20);
  });

  it("each one uses border-input (directly or through its file's shared class string)", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const tag of fieldTags(src)) {
        if (/type="(hidden|checkbox|radio)"/.test(tag)) continue;
        // The trap field (Check 2 P3: "sa_hp", once "website"), off screen and aria-hidden.
        if (/name="(website|sa_hp)"/.test(tag)) continue;
        const cls = tag.match(/className=(?:"([^"]*)"|\{([\s\S]*)\})/);
        let text = cls?.[1] ?? cls?.[2] ?? "";
        // A shared class string (field.tsx's `control`, growth-admin's `field`).
        for (const v of text.match(/\b[a-z][A-Za-z]*\b/g) ?? []) {
          const decl = src.match(new RegExp(`const ${v}\\s*=\\s*\\n?\\s*"([^"]*)"`));
          if (decl) text += ` ${decl[1]}`;
        }
        if (/\bopacity-0\b/.test(text)) continue;
        if (!/\bborder-input\b/.test(text)) offenders.push(`${f}: ${tag.slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
