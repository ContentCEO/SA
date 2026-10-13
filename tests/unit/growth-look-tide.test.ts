import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lookFor } from "@/components/marketing/growth/looks";
import * as td from "@/components/marketing/growth/looks/tide-rules";
import * as rules from "@/components/marketing/growth/switch-rules";

/** Look 3, "Tide" (TEMPORARY `?look=3` preview): its clock and the CSS that plays it. */

const css = readFileSync("src/styles/theme.css", "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const LOOK = ':root[data-sa-look="3"]';
const sw = (state: string) => `${LOOK}[data-sa-switching="${state}"]`;

/** The declarations of the rule whose selector is exactly `selector` (not a longer one). */
function block(selector: string): Map<string, string> {
  const at = bare.search(new RegExp(`(^|\\n|\\}\\s*)${escape(selector)} \\{`));
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const open = bare.indexOf(`${selector} {`, at) + selector.length + 1;
  const body = bare.slice(open + 1, bare.indexOf("}", open));
  const decls = new Map<string, string>();
  for (const line of body
    .split(";")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const i = line.indexOf(":");
    decls.set(
      line.slice(0, i).trim(),
      line
        .slice(i + 1)
        .trim()
        .replace(/\s+/g, " "),
    );
  }
  return decls;
}
function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** A @keyframes block's text. */
function keyframes(name: string): string {
  const at = bare.indexOf(`@keyframes ${name} {`);
  if (at < 0) throw new Error(`no keyframes ${name}`);
  const end = bare.indexOf("\n}", at);
  return bare.slice(at, end + 2);
}
const anim = (sel: string) => block(sel).get("animation") ?? "";
/** The look's own CSS: from its first rule to the start of the next section. */
function section(): string {
  const start = bare.indexOf(".sa-td-water {");
  // Look 4's block follows this one.
  const end = bare.indexOf(".sa-bw-stage {", start);
  return bare.slice(start, end);
}

describe("look 3 (tide): timings", () => {
  it("is registered as look 3 with its own clock; the quiet paths keep OUT_DONE_MS", () => {
    const look = lookFor("3");
    expect(look.id).toBe("3");
    expect(look.timing).toEqual({
      themeAtMs: td.TIDE_THEME_AT_MS,
      realignAtMs: td.TIDE_REALIGN_AT_MS,
      doneMs: td.TIDE_DONE_MS,
      quietDoneMs: rules.OUT_DONE_MS,
    });
  });

  it("keeps its pinned values", () => {
    expect([
      td.TIDE_IN_MS,
      td.TIDE_THEME_AT_MS,
      td.TIDE_CHIP_AT_MS,
      td.TIDE_REALIGN_AT_MS,
      td.TIDE_OUT_AT_MS,
      td.TIDE_OUT_MS,
      td.TIDE_DONE_MS,
      td.TIDE_BUMPS,
    ]).toEqual([520, 580, 640, 1180, 1260, 300, 1740, 11]);
  });

  it("in, swap under full cover, chip, a held label, out, under 2s", () => {
    // The theme swaps once the tide is all the way in, with a frame or two to spare.
    expect(td.TIDE_IN_MS + 40).toBeLessThanOrEqual(td.TIDE_THEME_AT_MS);
    expect(td.TIDE_CHIP_AT_MS).toBeGreaterThan(td.TIDE_THEME_AT_MS);
    expect(td.TIDE_THEME_AT_MS).toBeLessThan(td.TIDE_REALIGN_AT_MS);
    expect(td.TIDE_REALIGN_AT_MS).toBeLessThan(td.TIDE_OUT_AT_MS);
    // "One-on-one" holds, inverted, for 600ms or more before the tide goes out.
    expect(td.TIDE_OUT_AT_MS - td.TIDE_CHIP_AT_MS).toBeGreaterThanOrEqual(600);
    // Cleanup after the tide is out and the headline has landed (out + 40 + 60 + 300ms).
    expect(td.TIDE_DONE_MS).toBeGreaterThan(td.TIDE_OUT_AT_MS + td.TIDE_OUT_MS);
    expect(td.TIDE_DONE_MS).toBeGreaterThan(td.TIDE_OUT_AT_MS + rules.LAND_AFTER_LIFT_MS + 360);
    expect(td.TIDE_DONE_MS).toBeLessThan(2000);
  });

  it("the rules file is pure: no server-only, no database, no DOM", () => {
    const src = readFileSync("src/components/marketing/growth/looks/tide-rules.ts", "utf8");
    expect(src).not.toMatch(/server-only|@\/db|document\.|window\.|import /);
  });
});

describe("look 3 (tide): theme.css", () => {
  it("the animations use the timings in tide-rules.ts", () => {
    expect(anim(`${sw("in")} .sa-td-water`)).toBe(
      `sa-td-in ${td.TIDE_IN_MS}ms linear both, ` +
        `sa-td-out ${td.TIDE_OUT_MS}ms cubic-bezier(0.5, 0, 0.75, 0) ${td.TIDE_OUT_AT_MS}ms forwards`,
    );
    // Each quiet path moves with the scroll: down off the screen on the way up, up on the way down.
    expect(anim(`${sw("out")} .sa-td-water`)).toBe(
      `sa-td-out ${rules.QUIET_MS}ms cubic-bezier(0.65, 0, 0.35, 1) both`,
    );
    expect(anim(`${sw("in-quiet")} .sa-td-water`)).toBe(
      `sa-td-recede-up ${rules.QUIET_MS}ms cubic-bezier(0.65, 0, 0.35, 1) both`,
    );
    expect(anim(`${sw("in")} .sa-td-label[data-label="from"] .sa-td-chip`)).toBe(
      `sa-switch-edge-off 1ms linear ${td.TIDE_CHIP_AT_MS}ms forwards`,
    );
    expect(anim(`${sw("in")} .sa-td-label[data-label="to"] .sa-td-chip`)).toBe(
      `sa-switch-edge-on 1ms linear ${td.TIDE_CHIP_AT_MS}ms forwards`,
    );
    // One line: the words share a place and swap, chip and all, in the same frame.
    expect(anim(`${sw("in")} .sa-td-label[data-label="from"]`)).toBe(
      `sa-switch-edge-off 1ms linear ${td.TIDE_CHIP_AT_MS}ms forwards`,
    );
    expect(anim(`${sw("in")} .sa-td-label[data-label="to"]`)).toBe(
      `sa-switch-edge-on 1ms linear ${td.TIDE_CHIP_AT_MS}ms forwards`,
    );
    expect(block('.sa-td-label[data-label="to"]').get("opacity")).toBe("0");
    expect(block(".sa-td-label").get("grid-row")).toBe("1");
    expect(block(".sa-td-label").get("grid-column")).toBe("1");
    expect(anim(`${sw("in")} .sa-td-roll`)).toBe("sa-td-roll 800ms linear infinite");
    const land = td.TIDE_OUT_AT_MS + rules.LAND_AFTER_LIFT_MS - td.TIDE_THEME_AT_MS;
    const landSel = `${LOOK}[data-sa-theme="growth"][data-sa-switching="in"] .sa-land > span`;
    expect(block(landSel).get("animation-delay")).toBe(`${land}ms`);
    expect(block(`${landSel} + span`).get("animation-delay")).toBe(`${land + 60}ms`);

    expect(block(".sa-td-water").get("background-color")).toBe("var(--sa-k-charcoal)");
    expect(
      block(`${sw("in-quiet")} .sa-td-water,\n${sw("in-quiet")} .sa-td-bump`).get(
        "background-color",
      ),
    ).toBe("var(--sa-k-paper)");
  });

  it("the timing comment matches tide-rules.ts", () => {
    for (const name of ["TIDE_THEME_AT_MS", "TIDE_REALIGN_AT_MS", "TIDE_DONE_MS"] as const) {
      const m = css.match(new RegExp(`${name} = (\\d+)`));
      expect(m, name).not.toBeNull();
      expect(Number(m![1])).toBe(td[name]);
    }
  });

  it("in: off screen, two surges, all the way in; out: past the crest, which is under 2rem", () => {
    const off = "translateY(calc(100% + 2.5rem))";
    expect(block(".sa-td-water").get("transform")).toBe(off);
    const into = keyframes("sa-td-in");
    const stops = [...into.matchAll(/(\d+)% \{\s*transform: translateY\(([\d.]+)%?\)/g)].map(
      (m) => [Number(m[1]), Number(m[2])],
    );
    expect(stops).toEqual([
      [0, 100],
      [48, 30],
      [66, 48],
      [100, 0],
    ]);
    const out = keyframes("sa-td-out");
    expect(out).toContain("transform: translateY(0);");
    expect(out).toContain(`transform: ${off};`);
    // Up, on the way down (in-quiet): past the crest at the top of the screen.
    const up = keyframes("sa-td-recede-up");
    expect(up).toContain("transform: translateY(0);");
    expect(up).toContain("transform: translateY(calc(-100% - 2.5rem));");
    // The crest is at most 2.25rem tall, so out and up carry it off the screen; clamp() has a
    // fallback.
    const crest = section().slice(section().indexOf(".sa-td-crest {"));
    expect(crest.indexOf("height: 1.25rem;")).toBeLessThan(
      crest.indexOf("height: clamp(1rem, 4vw, 2.25rem);"),
    );
    expect(block(".sa-td-crest").get("bottom")).toBe("100%");
    // Going up, the crest moves to the leading (bottom) edge, bumps pointing down.
    const flipped = block(`${sw("in-quiet")} .sa-td-crest`);
    expect(flipped.get("top")).toBe("100%");
    expect(flipped.get("bottom")).toBe("auto");
    expect(flipped.get("transform")).toBe("scaleY(-1)");
    // The outline stays 4px, so the receding line shows on the charcoal page.
    expect(block(".sa-td-bump").get("border")).toBe("4px solid var(--sa-k-offwhite)");
    // Ten bumps across, one spare: the roll moves exactly one bump, so it loops with no seam.
    expect(block(".sa-td-bump").get("flex")).toBe("0 0 10vw");
    expect(block(".sa-td-roll").get("width")).toBe(`${(td.TIDE_BUMPS - 1) * 10 + 10}vw`);
    expect(keyframes("sa-td-roll")).toContain("transform: translateX(-10vw);");
    // The line rides just behind the crest (it moves with the water, in and out).
    expect(block(".sa-td-title").get("top")).toBe("8%");
    expect(block(".sa-td-title").get("display")).toBe("grid");
    // Each word as big as fits, 12vh at most; min() has a plain fallback declared first.
    for (const [side, vw] of [
      ["from", "18vw"],
      ["to", "14vw"],
    ] as const) {
      const rule = section().slice(section().indexOf(`.sa-td-label[data-label="${side}"] {`));
      const body = rule.slice(0, rule.indexOf("}"));
      expect(body.indexOf(`font-size: ${vw};`)).toBeGreaterThan(0);
      expect(body.indexOf(`font-size: ${vw};`)).toBeLessThan(
        body.indexOf(`font-size: min(${vw}, 12vh);`),
      );
    }
    // The water reaches 1px up under the crest (no hairline between the two layers), and under
    // its bottom edge when the crest is flipped there.
    const strip = block(".sa-td-water::before");
    expect(strip.get("top")).toBe("-1px");
    expect(strip.get("height")).toBe("2px");
    expect(strip.get("background-color")).toBe("inherit");
    expect(block(`${sw("in-quiet")} .sa-td-water::before`).get("bottom")).toBe("-1px");
  });

  it("transforms and 1ms flips only: no clips, no fades, two tones from the theme constants", () => {
    const s = section();
    expect(s.length).toBeGreaterThan(1000);
    expect(s).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|gradient|shadow|blur|filter|clip-path/i);
    expect(s).not.toMatch(/\binset:/);
    expect(s).not.toMatch(/transition/);
    for (const v of s.match(/var\(--[a-z-]+\)/g) ?? []) {
      expect(["var(--sa-k-charcoal)", "var(--sa-k-offwhite)", "var(--sa-k-paper)"]).toContain(v);
    }
    for (const m of s.matchAll(/sa-switch-edge-(?:on|off) (\d+)ms/g)) expect(m[1]).toBe("1");
    // Going out in the full show is forwards only (a backwards fill would empty the screen at 0ms).
    const outs = [...s.matchAll(/sa-td-out \d+ms cubic-bezier\([^)]*\) (\d+)ms (\w+)/g)];
    expect(outs.length).toBe(1);
    for (const m of outs) expect(m[2]).toBe("forwards");
    // The title only rides the full show; the crest only rolls in it.
    expect(block(".sa-td-card").get("display")).toBe("none");
    expect(s).not.toMatch(/data-sa-switching="(out|in-quiet)"\][^{]*\.sa-td-(card|title|roll)/);
  });

  it("the markup carries no class of another look, so their rules can't reach it", () => {
    const src = readFileSync("src/components/marketing/growth/looks/tide.tsx", "utf8");
    const classes = (src.match(/className="[^"]*"/g) ?? []).join(" ");
    expect(classes).toContain("sa-td-water");
    expect(classes).not.toMatch(/sa-switch-|sa-ls-|sa-cu-/);
    expect(src).toContain("data-sa-switch-graphic");
    expect(src).not.toMatch(/role=|tabIndex|aria-pressed|onClick|<button|<a /);
  });
});
