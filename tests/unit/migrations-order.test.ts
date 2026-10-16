import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Previews and production share one database, and drizzle's migrator applies only the
 * migrations whose journal `when` is later than the last one it applied. A branch merged after
 * another branch's migration already ran there must sort after it, or its own migration is
 * silently skipped (the leads + ideas merge renumbered 0032_control / 0033_numbers to 0033 /
 * 0034 for this reason).
 */
type Entry = { idx: number; when: number; tag: string };
const journal = JSON.parse(readFileSync(join("drizzle", "meta", "_journal.json"), "utf8")) as {
  entries: Entry[];
};
const entries = journal.entries;

describe("migration journal", () => {
  it("numbers entries 0, 1, 2… with tags that start with the same number", () => {
    entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      expect(e.tag.slice(0, 4)).toBe(String(i).padStart(4, "0"));
    });
  });

  it("has every `when` strictly increasing in idx order", () => {
    for (let i = 1; i < entries.length; i++) {
      expect(
        entries[i]!.when,
        `${entries[i]!.tag} must be later than ${entries[i - 1]!.tag}`,
      ).toBeGreaterThan(entries[i - 1]!.when);
    }
  });

  it("has one SQL file per entry and no stray migration files", () => {
    const files = readdirSync("drizzle").filter((f) => f.endsWith(".sql"));
    expect(files.sort()).toEqual(entries.map((e) => `${e.tag}.sql`).sort());
  });

  it("chains every snapshot to the one before it", () => {
    let prev: string | null = null;
    for (const e of entries) {
      const path = join("drizzle", "meta", `${String(e.idx).padStart(4, "0")}_snapshot.json`);
      expect(existsSync(path), path).toBe(true);
      const snap = JSON.parse(readFileSync(path, "utf8")) as { id: string; prevId: string };
      if (prev) expect(snap.prevId, path).toBe(prev);
      prev = snap.id;
    }
  });

  it("puts the ideas migrations after 0032_leads (already applied on the shared database)", () => {
    const at = (tag: string) => entries.findIndex((e) => e.tag === tag);
    expect(at("0032_leads")).toBe(32);
    expect(at("0033_control")).toBe(33);
    expect(at("0034_numbers")).toBe(34);
    expect(entries[33]!.when).toBeGreaterThan(entries[32]!.when);
  });
});
