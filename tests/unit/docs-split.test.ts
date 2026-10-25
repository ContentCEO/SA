import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ROOT } from "../support/source-ast";

/**
 * Check 49 P5: CLAUDE.md keeps the rules and an index; the Decisions bullets moved, word for
 * word, to docs/decisions/*.md. The fixture holds the first 80 characters of every top-level
 * bullet of the old Decisions section (generated once from the old CLAUDE.md): each must start
 * exactly one line across the decisions files, so nothing was dropped or copied twice.
 */

const DIR = join(ROOT, "docs/decisions");
const files = readdirSync(DIR).filter((f) => f.endsWith(".md"));
const lines = files.flatMap((f) =>
  readFileSync(join(DIR, f), "utf8")
    .split("\n")
    .map((line) => ({ f, line })),
);
const fixture = readFileSync(join(ROOT, "tests/fixtures/decision-bullets.txt"), "utf8")
  .split("\n")
  .filter(Boolean);
const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("the CLAUDE.md split", () => {
  it("has the seven area files and a full fixture", () => {
    expect(files.sort()).toEqual([
      "admin-and-ops.md",
      "ai-and-prompts.md",
      "gmail-and-sync.md",
      "lifecycle-and-billing.md",
      "platform.md",
      "queue-and-sending.md",
      "site-and-growth.md",
    ]);
    expect(fixture.length).toBe(159);
  });

  it("every old Decisions bullet starts exactly one line in docs/decisions", () => {
    const wrong = fixture
      .map((p) => ({ p, hits: lines.filter((l) => l.line.startsWith(p)).map((l) => l.f) }))
      .filter((x) => x.hits.length !== 1);
    expect(wrong).toEqual([]);
  });

  it("CLAUDE.md is short and indexes every decisions file", () => {
    expect(claude.split("\n").length).toBeLessThan(350);
    expect(claude).toContain("Before changing an area, read its decisions file.");
    for (const f of files) expect(claude, f).toContain(`docs/decisions/${f}`);
    for (const p of fixture) expect(claude.includes(p), p).toBe(false);
  });

  it("CLAUDE.md still states every rule a test or gate depends on", () => {
    const text = flat(claude);
    for (const rule of [
      "## Working in parallel",
      "A migration is frozen the moment its branch is pushed",
      "`SENDING_ALLOWED`",
      "setup_paid_via` ∈ {`stripe`, `house`}",
      "`JOBS_ALLOWED`",
      "Autopilot has three layers",
      "Never log tokens, email bodies, or customer personal details.",
      "Migrations are additive",
      "Two-tone only.",
      "Only two places can send mail",
      "Email text goes only to Anthropic",
      "/admin shows no email content",
      "Growth code never reads inbox data",
    ]) {
      expect(text, rule).toContain(rule);
    }
  });
});
