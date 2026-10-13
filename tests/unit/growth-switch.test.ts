import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as rules from "@/components/marketing/growth/switch-rules";
import {
  jumpMode,
  nextMode,
  rootHeight,
  rootMarginFor,
} from "@/components/marketing/growth/switch-rules";

/** The homepage switch from the app to Squared Away Growth: rules and the CSS that plays it. */

const css = readFileSync("src/styles/theme.css", "utf8");
const PALETTE = ["charcoal", "offwhite", "paper", "stone", "ash", "slate", "graphite"];
const RESTORED_TOKENS = [
  "--popover",
  "--popover-foreground",
  "--secondary",
  "--secondary-foreground",
  "--accent",
  "--accent-foreground",
  "--destructive",
];

/** The declarations of the first rule whose selector list is exactly `selector`. */
function block(selector: string): Map<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  const body = css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
  const decls = new Map<string, string>();
  for (const line of body
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(";")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const i = line.indexOf(":");
    decls.set(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return decls;
}

const GROWTH = ':root[data-sa-theme="growth"]';
const RESTORE =
  ':root[data-sa-theme="growth"] .sa-inverted,\n:root[data-sa-theme="growth"] .sa-light';
const APP_WRAPPER = ':root[data-sa-theme="app"] [data-sa-half="growth"]';
const APP_LIGHT = ':root[data-sa-theme="app"] [data-sa-half="growth"] .sa-light';

describe("nextMode: hysteresis between 85% and 100% of the screen", () => {
  const vh = 800;
  it.each([
    ["app", 0.85 * vh, "growth"],
    ["app", 0.86 * vh, "app"],
    ["app", 0.99 * vh, "app"],
    ["growth", 0.99 * vh, "growth"],
    ["growth", 0.86 * vh, "growth"],
    ["growth", 1.0 * vh, "app"],
    ["app", 0.5 * vh, "growth"],
    ["app", -1200, "growth"],
    ["growth", -1200, "growth"],
    ["app", vh * 3, "app"],
    ["growth", vh * 3, "app"],
  ] as const)("%s at top %d → %s", (current, top, expected) => {
    expect(nextMode(current, top, vh)).toBe(expected);
  });

  it("the switch fires as Growth comes up, before the opener can be read on paper", () => {
    expect(rules.SWITCH_IN_AT).toBeGreaterThanOrEqual(0.8);
    expect(rules.SWITCH_OUT_AT).toBe(1);
    expect(rules.LINES).toEqual([rules.SWITCH_IN_AT, rules.SWITCH_OUT_AT]);
  });

  it("navigation picks a side with one line in the middle of the band", () => {
    expect(rules.JUMP_AT).toBeCloseTo(0.925);
    expect(jumpMode(0.92 * vh, vh)).toBe("growth");
    expect(jumpMode(0.93 * vh, vh)).toBe("app");
    expect(jumpMode(-5000, vh)).toBe("growth");
    expect(jumpMode(5 * vh, vh)).toBe("app");
  });

  it("observer margins put each root's bottom on its line", () => {
    expect(rootMarginFor(rules.SWITCH_IN_AT)).toBe("0px 0px -15% 0px");
    expect(rootMarginFor(rules.SWITCH_OUT_AT)).toBe("0px 0px 0% 0px");
  });

  it("decides with the height the observer fired on, not window.innerHeight", () => {
    // Phone scrolling back up: innerHeight 800, but the observer's root is 744 tall (toolbar).
    // The out observer fires at top = 744, its line. With innerHeight that reading sits in the
    // band and keeps Growth, and no later callback would ever come.
    const inner = 800;
    const outH = rootHeight(744, rules.SWITCH_OUT_AT, inner);
    expect(outH).toBe(744);
    expect(nextMode("growth", 744, outH)).toBe("app");
    expect(nextMode("growth", 744, inner)).toBe("growth"); // the bug this avoids

    // The reverse (innerHeight smaller, e.g. pinch zoom): the in observer fires at 0.85 × 900.
    const inH = rootHeight(0.85 * 900, rules.SWITCH_IN_AT, 700);
    expect(inH).toBeCloseTo(900);
    expect(nextMode("app", 0.85 * 900, inH)).toBe("growth");
    expect(nextMode("app", 0.85 * 900, 700)).toBe("app"); // the bug this avoids

    // No root bounds (or a degenerate one): fall back.
    expect(rootHeight(null, 0.85, 700)).toBe(700);
    expect(rootHeight(undefined, 0.85, 700)).toBe(700);
    expect(rootHeight(0, 0.85, 700)).toBe(700);
  });

  it("keeps its timings: the end state holds 600ms+, the whole show stays under 2s", () => {
    expect(rules.IN_THEME_AT_MS).toBe(360);
    expect(rules.KNOB_AT_MS).toBe(420);
    expect(rules.KNOB_MS).toBe(220);
    expect(rules.FLOOD_OUT_AT_MS).toBe(1250);
    expect(rules.IN_REALIGN_AT_MS).toBe(1150);
    expect(rules.IN_DONE_MS).toBe(1740);
    expect(rules.QUIET_MS).toBe(260);
    expect(rules.OUT_DONE_MS).toBe(300);
    expect(rules.SETTLE_MS).toBe(500);
    expect(rules.NAV_MS).toBe(1000);
    const landed = rules.KNOB_AT_MS + rules.KNOB_MS;
    expect(rules.FLOOD_OUT_AT_MS - landed).toBeGreaterThanOrEqual(600);
    // The theme swaps under full cover (flood-in is 300ms) and before the knob moves.
    expect(rules.IN_THEME_AT_MS).toBeGreaterThan(300);
    expect(rules.IN_THEME_AT_MS).toBeLessThan(rules.KNOB_AT_MS);
    // The second move to the opener is still under full cover, after the first.
    expect(rules.IN_REALIGN_AT_MS).toBeGreaterThan(rules.IN_THEME_AT_MS);
    expect(rules.IN_REALIGN_AT_MS).toBeLessThan(rules.FLOOD_OUT_AT_MS);
    // Cleanup after the headline has landed (flood-out start + 40 + 60 + 300ms).
    expect(rules.IN_DONE_MS).toBeGreaterThan(
      rules.FLOOD_OUT_AT_MS + rules.LAND_AFTER_LIFT_MS + 360,
    );
    expect(rules.IN_DONE_MS).toBeLessThan(2000);
    expect(rules.OUT_DONE_MS).toBeGreaterThan(rules.QUIET_MS);
  });

  it("is pure: no server-only, no database, no DOM", () => {
    const src = readFileSync("src/components/marketing/growth/switch-rules.ts", "utf8");
    expect(src).not.toMatch(/server-only|@\/db|document\.|window\./);
  });
});

describe("theme.css: the switch", () => {
  it("uses no scroll timelines and no old flip", () => {
    for (const banned of ["animation-timeline", "view-timeline", "sa-flip"]) {
      expect(css).not.toContain(banned);
    }
  });

  it("clip-path only on the switch's dark labels, from the knob's box to the knob's box", () => {
    const clips = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/clip-path:[^;]*;/g) ?? [];
    const start = "clip-path: inset(4px 50% 4px 4px round 9999px);";
    const end = "clip-path: inset(4px 4px 4px 50% round 9999px);";
    expect(clips).toEqual([start, start, end]);
    // The knob it follows: 4px in, half the width less 4px, sliding its own width.
    const knob = block(".sa-switch-knob");
    expect(knob.get("left")).toBe("4px");
    expect(knob.get("top")).toBe("4px");
    expect(knob.get("bottom")).toBe("4px");
    expect(knob.get("width")).toBe("calc(50% - 4px)");
    expect(block(".sa-switch-graphic").get("overflow")).toBe("hidden");
    expect(css).not.toMatch(/steps\(1\)/);
  });

  it("the animations use the timings in switch-rules.ts", () => {
    const decl = (sel: string) => block(sel).get("animation") ?? "";
    const flood = decl(':root[data-sa-switching="in"] .sa-switch-flood');
    expect(flood).toMatch(/sa-switch-flood-in 300ms .* both/);
    expect(flood).toContain(
      `sa-switch-flood-out 240ms cubic-bezier(0.5, 0, 0.75, 0) ${rules.FLOOD_OUT_AT_MS}ms forwards`,
    );
    const knob = `${rules.KNOB_MS}ms cubic-bezier(0.65, 0, 0.35, 1) ${rules.KNOB_AT_MS}ms forwards`;
    expect(decl(':root[data-sa-switching="in"] .sa-switch-knob')).toBe(`sa-switch-knob ${knob}`);
    expect(decl(':root[data-sa-switching="in"] .sa-switch-labels[data-ink="dark"]')).toBe(
      `sa-switch-ink ${knob}`,
    );
    expect(decl(':root[data-sa-switching="in"] .sa-switch-edge[data-edge="bottom"]')).toContain(
      `${rules.FLOOD_OUT_AT_MS}ms`,
    );
    const land = rules.FLOOD_OUT_AT_MS + rules.LAND_AFTER_LIFT_MS - rules.IN_THEME_AT_MS;
    expect(decl(':root[data-sa-theme="growth"][data-sa-switching="in"] .sa-land > span')).toContain(
      ` ${land}ms both`,
    );
    expect(
      block(':root[data-sa-theme="growth"][data-sa-switching="in"] .sa-land > span + span').get(
        "animation-delay",
      ),
    ).toBe(`${land + 60}ms`);
    for (const [path, wipe] of [
      ["out", "sa-switch-wipe-down"],
      ["in-quiet", "sa-switch-wipe-up"],
    ] as const) {
      expect(decl(`:root[data-sa-switching="${path}"] .sa-switch-flood`)).toBe(
        `${wipe} ${rules.QUIET_MS}ms cubic-bezier(0.65, 0, 0.35, 1) both`,
      );
    }
  });

  it("the quiet paths wipe with transforms: no opacity veil, no third tone", () => {
    expect(css).not.toContain("sa-switch-veil");
    const quietRules =
      css.match(/:root\[data-sa-switching="(out|in-quiet)"\] \.sa-switch-flood \{[^}]*\}/g) ?? [];
    expect(quietRules.length).toBe(2);
    for (const r of quietRules) expect(r).not.toMatch(/opacity/);
  });

  it("only the moving edge shows, and the pill is centred in the small viewport", () => {
    expect(
      block(':root[data-sa-switching="in"] .sa-switch-edge[data-edge="top"]').get("animation"),
    ).toMatch(/^sa-switch-edge-off 120ms ease-out 300ms forwards$/);
    expect(
      block(':root[data-sa-switching="in"] .sa-switch-edge[data-edge="bottom"]').get("opacity"),
    ).toBe("0");
    const center = css.slice(css.indexOf(".sa-switch-center {"));
    expect(center.indexOf("top: 50%;")).toBeLessThan(center.indexOf("top: 50svh;"));
    expect(center.indexOf("top: 50svh;")).toBeGreaterThan(0);
  });

  it("writes each brand colour once, as a constant on :root", () => {
    const hexes = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(hexes.map((h) => h.toLowerCase()).sort()).toEqual(
      ["#1b1b1b", "#efeeea", "#f7f6f3", "#d9d7d0", "#9a9994", "#5e5d59", "#262625"].sort(),
    );
    for (const name of PALETTE) {
      expect(css).toMatch(new RegExp(`--sa-k-${name}: #[0-9a-f]{6};`));
      expect(css).toContain(`--sa-${name}: var(--sa-k-${name});`);
    }
  });

  it("every value in the swap blocks is a constant", () => {
    for (const sel of [GROWTH, RESTORE, APP_WRAPPER, APP_LIGHT]) {
      for (const [prop, value] of block(sel)) {
        expect(value, `${sel} ${prop}`).toMatch(/^var\(--sa-k-[a-z]+\)$/);
      }
    }
  });

  it("growth mode swaps all seven colours; islands get all seven back plus the other tokens", () => {
    const growth = block(GROWTH);
    for (const name of PALETTE) expect(growth.has(`--sa-${name}`)).toBe(true);
    expect(growth.get("--sa-paper")).toBe("var(--sa-k-charcoal)");
    expect(growth.get("--sa-charcoal")).toBe("var(--sa-k-offwhite)");
    expect(growth.get("--input")).toBe("var(--sa-k-ash)");
    expect(growth.get("background-color")).toBe("var(--sa-k-charcoal)");

    const restore = block(RESTORE);
    for (const name of PALETTE) expect(restore.get(`--sa-${name}`)).toBe(`var(--sa-k-${name})`);
    for (const token of RESTORED_TOKENS) expect(restore.has(token), token).toBe(true);

    const light = block(APP_LIGHT);
    for (const name of PALETTE) expect(light.get(`--sa-${name}`)).toBe(`var(--sa-k-${name})`);
  });

  it("app mode maps all seven colours on the Growth wrapper, so nothing dark shows early", () => {
    const wrapper = block(APP_WRAPPER);
    for (const name of PALETTE) expect(wrapper.has(`--sa-${name}`)).toBe(true);
    expect(wrapper.get("--sa-charcoal")).toBe("var(--sa-k-paper)");
    expect(wrapper.get("--border")).toBe("var(--sa-k-stone)");
    expect(wrapper.get("--input")).toBe("var(--sa-k-stone)");
  });

  it("the flood leaves forwards only, never both (a backwards fill would kill the sweep)", () => {
    // Up to the end of the declaration (the commas inside cubic-bezier() are part of it).
    const uses = css.match(/sa-switch-flood-out \d[^;]*/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) {
      expect(use).not.toMatch(/\bboth\b/);
      expect(use).toContain("forwards");
    }
  });

  it("the stage never takes a tap, and reduced motion hides it", () => {
    const stage = block(".sa-switch-stage");
    expect(stage.get("pointer-events")).toBe("none");
    expect(stage.get("display")).toBe("none");
    const reduced = css.slice(
      css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .sa-switch"),
    );
    expect(reduced).toMatch(/\.sa-switch-stage\s*\{\s*display: none !important;/);
    expect(reduced).toMatch(/\.sa-land > span\s*\{\s*animation: none !important;/);
  });

  it("the timing comment matches switch-rules.ts", () => {
    for (const name of [
      "IN_THEME_AT_MS",
      "IN_REALIGN_AT_MS",
      "IN_DONE_MS",
      "OUT_DONE_MS",
    ] as const) {
      const m = css.match(new RegExp(`${name} = (\\d+)`));
      expect(m, name).not.toBeNull();
      expect(Number(m![1])).toBe(rules[name]);
    }
  });
});

describe("no literal colours on the homepage", () => {
  const ALLOWED = ["rgba(27,27,27,0.45)"]; // QueuePreview's shadow: harmless on charcoal.
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : /\.(tsx?|css)$/.test(p) ? [p] : [];
    });
  }
  it("page.tsx, marketing components and the footer use theme tokens only", () => {
    const sources = [
      "src/app/page.tsx",
      "src/components/app/site-footer.tsx",
      ...files("src/components/marketing"),
    ];
    for (const f of sources) {
      let text = readFileSync(f, "utf8");
      for (const ok of ALLOWED) text = text.split(ok).join("");
      expect(text, f).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    }
  });
});
