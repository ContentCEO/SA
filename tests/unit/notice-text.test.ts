import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isCategory } from "@/config/categories";
import { noticeText } from "@/lib/notice-text";

/**
 * Check 26 P6: ?done=constructor (or __proto__, toString…) used to find the object's built-in
 * function and break the screen. Only the map's own string entries are notices.
 */
const MAP = { saved: "Saved.", odd: 1 as unknown as string };

describe("noticeText", () => {
  it("returns the words for a real key", () => {
    expect(noticeText(MAP, "saved")).toBe("Saved.");
  });

  for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "nope"]) {
    it(`GUARDRAIL: "${key}" is not a notice`, () => {
      expect(noticeText(MAP, key)).toBeUndefined();
    });
  }

  it("ignores a non-string key or value", () => {
    for (const key of [undefined, null, 1, ["saved"], { saved: 1 }])
      expect(noticeText(MAP, key)).toBeUndefined();
    expect(noticeText(MAP, "odd")).toBeUndefined();
  });

  it("the inbox's ?c= category check takes own keys only", () => {
    expect(isCategory("quote_request")).toBe(true);
    for (const key of ["constructor", "__proto__", "toString"]) expect(isCategory(key)).toBe(false);
  });
});

describe("no screen looks a query value up by plain indexing", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(f) ? [p] : [];
    });
  it("no `map[params.x]` / `map[doneKey]` lookups left in src/app", () => {
    const hits = files("src/app").flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => /\w\[(params|sp)\.\w+( as \w+)?\]|\w\[(doneKey|errorKey)\]/.test(l))
        .map((l) => `${f}: ${l.trim()}`),
    );
    expect(hits).toEqual([]);
  });
});
