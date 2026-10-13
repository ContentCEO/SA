import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lookFor } from "@/components/marketing/growth/looks";
import * as light from "@/components/marketing/growth/looks/light-switch-rules";
import * as rules from "@/components/marketing/growth/switch-rules";

/** Look 1, "Light switch" (TEMPORARY `?look=1` preview): its clock and the CSS that plays it. */

const css = readFileSync("src/styles/theme.css", "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const LOOK = ':root[data-sa-look="1"]';

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
    decls.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
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
const anim = (sel: string) => (block(sel).get("animation") ?? "").replace(/\s+/g, " ");
/** The look's own CSS, from its first rule to the next look's comment. */
function section(): string {
  const start = bare.indexOf(".sa-ls-show {");
  return bare.slice(start, bare.indexOf(".sa-cu-stage {", start));
}

describe("look 1 (light switch): timings", () => {
  it("is registered as look 1 with its own clock; the quiet paths keep OUT_DONE_MS", () => {
    const look = lookFor("1");
    expect(look.id).toBe("1");
    expect(look.timing).toEqual({
      themeAtMs: light.LIGHT_THEME_AT_MS,
      realignAtMs: light.LIGHT_REALIGN_AT_MS,
      doneMs: light.LIGHT_DONE_MS,
      quietDoneMs: rules.OUT_DONE_MS,
    });
  });

  it("keeps its pinned values", () => {
    expect([
      light.LIGHT_POP_MS,
      light.LIGHT_FLIP_AT_MS,
      light.LIGHT_FLIP_MS,
      light.LIGHT_CLICK_AT_MS,
      light.LIGHT_DARK_AT_MS,
      light.LIGHT_DARK_MS,
      light.LIGHT_THEME_AT_MS,
      light.LIGHT_REALIGN_AT_MS,
      light.LIGHT_EXIT_AT_MS,
      light.LIGHT_EXIT_MS,
      light.LIGHT_DONE_MS,
      light.LIGHT_QUIET_MS,
    ]).toEqual([220, 260, 140, 350, 260, 300, 600, 1220, 1300, 240, 1780, 240]);
  });

  it("pop, then the dark as the paddle rocks, click at impact, swap under full cover, under 2s", () => {
    expect(light.LIGHT_POP_MS).toBeLessThan(light.LIGHT_FLIP_AT_MS);
    // The chips swap at the paddle's impact (64% of the rock).
    expect(
      Math.abs(light.LIGHT_FLIP_AT_MS + 0.64 * light.LIGHT_FLIP_MS - light.LIGHT_CLICK_AT_MS),
    ).toBeLessThanOrEqual(5);
    // The dark starts as the paddle starts to rock, so the page is covered fast.
    expect(light.LIGHT_DARK_AT_MS).toBe(light.LIGHT_FLIP_AT_MS);
    expect(light.LIGHT_DARK_AT_MS + light.LIGHT_DARK_MS).toBeLessThanOrEqual(560);
    // The theme swaps under full cover, with a frame or two to spare.
    expect(light.LIGHT_DARK_AT_MS + light.LIGHT_DARK_MS + 40).toBeLessThanOrEqual(
      light.LIGHT_THEME_AT_MS,
    );
    expect(light.LIGHT_THEME_AT_MS).toBeLessThan(light.LIGHT_REALIGN_AT_MS);
    expect(light.LIGHT_REALIGN_AT_MS).toBeLessThan(light.LIGHT_EXIT_AT_MS);
    // "One-on-one" holds, inverted, for 600ms or more before the exit.
    expect(light.LIGHT_EXIT_AT_MS - light.LIGHT_CLICK_AT_MS).toBeGreaterThanOrEqual(600);
    // The exit ends where the other looks' do.
    expect(light.LIGHT_EXIT_AT_MS + light.LIGHT_EXIT_MS).toBe(1540);
    // Cleanup after the headline has landed (exit + 40 + 60 + 300ms).
    expect(light.LIGHT_DONE_MS).toBeGreaterThan(
      light.LIGHT_EXIT_AT_MS + rules.LAND_AFTER_LIFT_MS + 360,
    );
    expect(light.LIGHT_DONE_MS).toBeLessThan(2000);
    // The quiet drain ends before cleanup.
    expect(light.LIGHT_QUIET_MS).toBeLessThanOrEqual(rules.QUIET_MS);
  });

  it("the disc reaches every corner at full size and starts hidden behind the plate", () => {
    const radius = light.LIGHT_DISC_VMAX / 2;
    // A square viewport's corner is 70.7vmax from its centre.
    expect(radius).toBeGreaterThanOrEqual(71);
    expect(radius * light.LIGHT_DRAIN_FROM_SCALE).toBeGreaterThanOrEqual(71);
    // ... and no bigger than that needs (the layer's texture grows with its area).
    expect(radius).toBeLessThanOrEqual(72);
    // 8.5vmax from the middle: inside the plate (at least 11rem wide) on a phone.
    expect(radius * light.LIGHT_DARK_FROM_SCALE).toBeLessThanOrEqual(10);
  });

  it("the rules file is pure: no server-only, no database, no DOM", () => {
    const src = readFileSync("src/components/marketing/growth/looks/light-switch-rules.ts", "utf8");
    expect(src).not.toMatch(/server-only|@\/db|document\.|window\.|import /);
  });
});

describe("look 1 (light switch): theme.css", () => {
  const sw = (state: string) => `${LOOK}[data-sa-switching="${state}"]`;

  it("the animations use the timings in light-switch-rules.ts", () => {
    const exit = `${light.LIGHT_EXIT_MS}ms cubic-bezier(0.3, 0.5, 0.5, 1) ${light.LIGHT_EXIT_AT_MS}ms forwards`;
    // One disc: the rim turns on (1ms) as the same element starts to drain, on the same clock.
    expect(anim(`${sw("in")} .sa-ls-dark`)).toBe(
      `sa-ls-dark ${light.LIGHT_DARK_MS}ms cubic-bezier(0.45, 0, 0.55, 1) ${light.LIGHT_DARK_AT_MS}ms forwards, ` +
        `sa-ls-rim 1ms linear ${light.LIGHT_EXIT_AT_MS}ms forwards, ` +
        `sa-ls-shrink ${exit}`,
    );
    // The rim is the dark's own border: unseen charcoal, then off-white.
    // Its own rule (the selector also ends the shared disc rule above it).
    expect(section()).toMatch(
      /\n\.sa-ls-dark \{\s*border: 6px solid var\(--sa-k-charcoal\);\s*background-color: var\(--sa-k-charcoal\);\s*\}/,
    );
    expect(keyframes("sa-ls-rim")).toMatch(
      /from \{\s*border-color: var\(--sa-k-charcoal\);\s*\}\s*to \{\s*border-color: var\(--sa-k-offwhite\);/,
    );
    // No second layer for the edge (two layers drift apart, and cost twice the texture).
    expect(bare).not.toContain("sa-ls-ring");
    expect(anim(`${sw("in")} .sa-ls-pop`)).toBe(
      `sa-ls-pop ${light.LIGHT_POP_MS}ms both, ` +
        `sa-ls-unpop ${light.LIGHT_EXIT_MS}ms ${light.LIGHT_EXIT_AT_MS}ms forwards`,
    );
    expect(anim(`${sw("in")} .sa-ls-paddle`)).toBe(
      `sa-ls-rock ${light.LIGHT_FLIP_MS}ms linear ${light.LIGHT_FLIP_AT_MS}ms forwards`,
    );
    expect(anim(`${sw("in")} .sa-ls-press`)).toBe(
      `sa-ls-press ${light.LIGHT_FLIP_MS}ms linear ${light.LIGHT_FLIP_AT_MS}ms forwards`,
    );
    for (const side of ["from", "to"]) {
      expect(anim(`${sw("in")} .sa-ls-label[data-label="${side}"] .sa-ls-chip`)).toContain(
        ` ${light.LIGHT_CLICK_AT_MS}ms forwards`,
      );
    }
    expect(anim(`${sw("in")} .sa-ls-plate`)).toBe(
      `sa-ls-thunk 160ms ease-out ${light.LIGHT_CLICK_AT_MS}ms`,
    );

    const land = light.LIGHT_EXIT_AT_MS + rules.LAND_AFTER_LIFT_MS - light.LIGHT_THEME_AT_MS;
    const landSel = `${LOOK}[data-sa-theme="growth"][data-sa-switching="in"] .sa-land > span`;
    expect(block(landSel).get("animation-delay")).toBe(`${land}ms`);
    expect(block(`${landSel} + span`).get("animation-delay")).toBe(`${land + 60}ms`);

    for (const state of ["out", "in-quiet"]) {
      // An ease-out: the drain moves from the first frame.
      expect(anim(`${sw(state)} .sa-ls-cover`)).toBe(
        `sa-ls-drain ${light.LIGHT_QUIET_MS}ms cubic-bezier(0.2, 0.7, 0.3, 1) both`,
      );
    }
    expect(block(`${sw("out")} .sa-ls-cover`).get("background-color")).toBe("var(--sa-k-charcoal)");
    expect(block(`${sw("in-quiet")} .sa-ls-cover`).get("background-color")).toBe(
      "var(--sa-k-paper)",
    );
  });

  it("the timing comment matches light-switch-rules.ts", () => {
    for (const name of ["LIGHT_THEME_AT_MS", "LIGHT_REALIGN_AT_MS", "LIGHT_DONE_MS"] as const) {
      const m = css.match(new RegExp(`${name} = (\\d+)`));
      expect(m, name).not.toBeNull();
      expect(Number(m![1])).toBe(light[name]);
    }
  });

  it("the dark and the cover are discs scaled by transform, centred on the plate", () => {
    const disc = block(".sa-ls-cover,\n.sa-ls-dark");
    const size = `${light.LIGHT_DISC_VMAX}vmax`;
    const half = `-${light.LIGHT_DISC_VMAX / 2}vmax`;
    expect(disc.get("width")).toBe(size);
    expect(disc.get("height")).toBe(size);
    expect(disc.get("margin-left")).toBe(half);
    expect(disc.get("margin-top")).toBe(half);
    expect(disc.get("left")).toBe("50%");
    expect(disc.get("border-radius")).toBe("9999px");
    expect(disc.get("transform")).toBe("scale(0)");
    // 50% first, then 50svh where it is known (older iOS keeps the first).
    const rule = section().slice(section().indexOf(".sa-ls-cover,\n.sa-ls-dark {"));
    expect(rule.indexOf("top: 50%;")).toBeLessThan(rule.indexOf("top: 50svh;"));

    const stops = (name: string) =>
      [...keyframes(name).matchAll(/transform: scale\(([\d.]+)\)/g)].map((m) => Number(m[1]));
    expect(stops("sa-ls-dark")).toEqual([light.LIGHT_DARK_FROM_SCALE, 1]);
    expect(stops("sa-ls-shrink")).toEqual([1, 0]);
    expect(stops("sa-ls-drain")).toEqual([light.LIGHT_DRAIN_FROM_SCALE, 0]);
    expect(stops("sa-ls-unpop")).toEqual([1, 1.05, 0]);
  });

  it("the paddle doesn't clip the moving press (a rounded 3D clip redraws every frame)", () => {
    expect(block(".sa-ls-paddle").get("overflow")).toBeUndefined();
    expect(block(".sa-ls-press").get("border-radius")).toBe("calc(0.75rem - 3px)");
    expect(block(".sa-ls-press").get("height")).toBe("50%");
    expect(keyframes("sa-ls-press")).toContain("transform: translateY(100%);");
  });

  it("the plate has plain sizes before min()/clamp() (older iOS)", () => {
    const plate = section().slice(section().indexOf(".sa-ls-plate {"));
    expect(plate.indexOf("width: 13rem;")).toBeLessThan(plate.indexOf("width: min("));
    expect(plate.indexOf("height: 19.5rem;")).toBeLessThan(plate.indexOf("height: min("));
  });

  it("transforms and 1ms flips only: no clips, two tones from the theme constants", () => {
    const s = section();
    expect(s.length).toBeGreaterThan(1000);
    expect(s).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|gradient|shadow|blur|filter|clip-path/i);
    expect(s).not.toMatch(/\binset:/);
    expect(s).not.toMatch(/transition/);
    for (const v of s.match(/var\(--[a-z-]+\)/g) ?? []) {
      expect(["var(--sa-k-charcoal)", "var(--sa-k-offwhite)", "var(--sa-k-paper)"]).toContain(v);
    }
    for (const m of s.matchAll(/sa-(?:switch-edge-(?:on|off)|ls-rim) (\d+)ms/g))
      expect(m[1]).toBe("1");
    // No lift and no cover like the current look's: this look ends its own way.
    expect(s).not.toMatch(/sa-switch-flood/);
    // Only the "in" show has the plate; the quiet paths show the cover alone.
    expect(block(".sa-ls-show").get("display")).toBe("none");
    expect(block(".sa-ls-cover").get("display")).toBe("none");
    expect(s).not.toMatch(/data-sa-switching="(out|in-quiet)"\][^{]*\.sa-ls-(show|dark|pop)/);
  });

  it("the markup carries no class of the current look, so its unscoped rules can't reach it", () => {
    const src = readFileSync("src/components/marketing/growth/looks/light-switch.tsx", "utf8");
    const classes = (src.match(/className="[^"]*"/g) ?? []).join(" ");
    expect(classes).toContain("sa-ls-plate");
    expect(classes).not.toMatch(/sa-switch-/);
    expect(src).toContain("data-sa-switch-graphic");
    expect(src).not.toMatch(/role=|tabIndex|aria-pressed|onClick|<button|<a /);
  });
});
