import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lookFor } from "@/components/marketing/growth/looks";
import * as bw from "@/components/marketing/growth/looks/big-words-rules";
import * as rules from "@/components/marketing/growth/switch-rules";

/** Look 4, "Big words" (TEMPORARY `?look=4` preview): its clock and the CSS that plays it. */

const css = readFileSync("src/styles/theme.css", "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const LOOK = ':root[data-sa-look="4"]';
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
  const start = bare.indexOf(".sa-bw-stage {");
  // Look 5's block follows this one, when it's there.
  const ends = [".sa-bl-blind {", "@media (prefers-reduced-motion: reduce)"]
    .map((m) => bare.indexOf(m, start))
    .filter((i) => i > start);
  return bare.slice(start, Math.min(...ends));
}
const BANDS = Array.from({ length: bw.BW_BANDS }, (_, i) => i);
const EASE_IN = "cubic-bezier(0.6, 0, 0.2, 1)";
const EASE_QUIET = "cubic-bezier(0.65, 0, 0.35, 1)";
const EASE_OUT = "cubic-bezier(0.5, 0, 0.75, 0)";

describe("look 4 (big words): timings", () => {
  it("is registered as look 4 with its own clock; the quiet paths keep OUT_DONE_MS", () => {
    const look = lookFor("4");
    expect(look.id).toBe("4");
    expect(look.timing).toEqual({
      themeAtMs: bw.BW_THEME_AT_MS,
      realignAtMs: bw.BW_REALIGN_AT_MS,
      doneMs: bw.BW_DONE_MS,
      quietDoneMs: rules.OUT_DONE_MS,
    });
  });

  it("keeps its pinned values", () => {
    expect([
      bw.BW_BANDS,
      bw.BW_BAND_MS,
      bw.BW_BAND_STAGGER_MS,
      bw.BW_THEME_AT_MS,
      bw.BW_TICK_AT_MS,
      bw.BW_TICK_MS,
      bw.BW_CHIP_AT_MS,
      bw.BW_REALIGN_AT_MS,
      bw.BW_OUT_AT_MS,
      bw.BW_OUT_MS,
      bw.BW_DONE_MS,
      bw.BW_COVERED_AT_MS,
      bw.BW_OUT_DONE_AT_MS,
    ]).toEqual([5, 240, 40, 380, 440, 240, 680, 1220, 1300, 160, 1740, 320, 1540]);
  });

  it("the middle band comes first, then outwards, and goes out last; sides alternate", () => {
    expect(BANDS.map(bw.bandDelayMs)).toEqual([80, 40, 0, 40, 80]);
    expect(BANDS.map(bw.bandOutDelayMs)).toEqual([1300, 1340, 1380, 1340, 1300]);
    expect(BANDS.map(bw.bandSide)).toEqual(["left", "right", "left", "right", "left"]);
    expect(bw.BW_COVERED_AT_MS).toBe(Math.max(...BANDS.map(bw.bandDelayMs)) + bw.BW_BAND_MS);
  });

  it("covered, swap, tick-over, chip, a held word, bands out, under 2s", () => {
    // The theme swaps once every band is in, with a frame or two to spare.
    expect(bw.BW_COVERED_AT_MS + 40).toBeLessThanOrEqual(bw.BW_THEME_AT_MS);
    // "The app" is whole on screen before it ticks out.
    expect(bw.BW_TICK_AT_MS).toBeGreaterThanOrEqual(bw.BW_BAND_MS + 150);
    expect(bw.BW_TICK_AT_MS).toBeGreaterThan(bw.BW_THEME_AT_MS);
    // The chip flips as "One-on-one" lands.
    expect(bw.BW_CHIP_AT_MS).toBe(bw.BW_TICK_AT_MS + bw.BW_TICK_MS);
    expect(bw.BW_THEME_AT_MS).toBeLessThan(bw.BW_REALIGN_AT_MS);
    expect(bw.BW_REALIGN_AT_MS).toBeLessThan(bw.BW_OUT_AT_MS);
    // "One-on-one" holds, inverted, for 600ms or more before the bands go.
    expect(bw.BW_OUT_AT_MS - bw.BW_CHIP_AT_MS).toBeGreaterThanOrEqual(600);
    // The exit ends where the other looks' do.
    expect(bw.BW_OUT_DONE_AT_MS).toBe(1540);
    // Cleanup after the bands are gone and the headline has landed (out + 40 + 60 + 300ms).
    expect(bw.BW_DONE_MS).toBeGreaterThan(bw.BW_OUT_DONE_AT_MS);
    expect(bw.BW_DONE_MS).toBeGreaterThan(bw.BW_OUT_AT_MS + rules.LAND_AFTER_LIFT_MS + 360);
    expect(bw.BW_DONE_MS).toBeLessThan(2000);
  });

  it("the rules file is pure: no server-only, no database, no DOM", () => {
    const src = readFileSync("src/components/marketing/growth/looks/big-words-rules.ts", "utf8");
    expect(src).not.toMatch(/server-only|@\/db|document\.|window\.|import /);
  });
});

describe("look 4 (big words): theme.css", () => {
  it("the animations use the timings in big-words-rules.ts", () => {
    for (const i of BANDS) {
      const delay = bw.bandDelayMs(i);
      expect(anim(`${sw("in")} .sa-bw-band[data-band="${i}"]`), `band ${i}`).toBe(
        `sa-bw-in-${bw.bandSide(i)} ${bw.BW_BAND_MS}ms ${EASE_IN}${delay ? ` ${delay}ms` : ""} both, ` +
          `sa-bw-out-${bw.bandSide(i)} ${bw.BW_OUT_MS}ms ${EASE_OUT} ${bw.bandOutDelayMs(i)}ms forwards`,
      );
    }
    for (const side of ["left", "right"]) {
      const sel = `${sw("out")} .sa-bw-band[data-side="${side}"],\n${sw("in-quiet")} .sa-bw-band[data-side="${side}"]`;
      expect(anim(sel)).toBe(`sa-bw-out-${side} ${rules.QUIET_MS}ms ${EASE_QUIET} both`);
    }
    expect(anim(`${sw("in")} .sa-bw-word[data-word="from"]`)).toBe(
      `sa-bw-tick-out ${bw.BW_TICK_MS}ms cubic-bezier(0.6, 0, 0.4, 1) ${bw.BW_TICK_AT_MS}ms forwards`,
    );
    expect(anim(`${sw("in")} .sa-bw-word[data-word="to"]`)).toBe(
      `sa-bw-tick-in ${bw.BW_TICK_MS}ms linear ${bw.BW_TICK_AT_MS}ms forwards`,
    );
    expect(anim(`${sw("in")} .sa-bw-word[data-word="from"] .sa-bw-chip`)).toBe(
      `sa-switch-edge-off 1ms linear ${bw.BW_CHIP_AT_MS}ms forwards`,
    );
    expect(anim(`${sw("in")} .sa-bw-word[data-word="to"] .sa-bw-chip`)).toBe(
      `sa-switch-edge-on 1ms linear ${bw.BW_CHIP_AT_MS}ms forwards`,
    );
    const land = bw.BW_OUT_AT_MS + rules.LAND_AFTER_LIFT_MS - bw.BW_THEME_AT_MS;
    const landSel = `${LOOK}[data-sa-theme="growth"][data-sa-switching="in"] .sa-land > span`;
    expect(block(landSel).get("animation-delay")).toBe(`${land}ms`);
    expect(block(`${landSel} + span`).get("animation-delay")).toBe(`${land + 60}ms`);

    expect(block(".sa-bw-band").get("background-color")).toBe("var(--sa-k-charcoal)");
    expect(block(`${sw("in-quiet")} .sa-bw-band`).get("background-color")).toBe(
      "var(--sa-k-paper)",
    );
  });

  it("the timing comment matches big-words-rules.ts", () => {
    for (const name of ["BW_THEME_AT_MS", "BW_REALIGN_AT_MS", "BW_DONE_MS"] as const) {
      const m = css.match(new RegExp(`${name} = (\\d+)`));
      expect(m, name).not.toBeNull();
      expect(Number(m![1])).toBe(bw[name]);
    }
  });

  it("five bands tile the screen with a 1px overlap; words fill the middle band", () => {
    expect(block(".sa-bw-band").get("height")).toBe("calc(20% + 1px)");
    expect(block(".sa-bw-band").get("overflow")).toBe("hidden");
    for (const i of BANDS) {
      expect(block(`.sa-bw-band[data-band="${i}"]`).get("top")).toBe(i === 0 ? "0" : `${i * 20}%`);
    }
    expect(block('.sa-bw-band[data-side="left"]').get("transform")).toBe("translateX(-100%)");
    expect(block('.sa-bw-band[data-side="right"]').get("transform")).toBe("translateX(100%)");
    expect(keyframes("sa-bw-in-left")).toContain("transform: translateX(-100%);");
    expect(keyframes("sa-bw-in-right")).toContain("transform: translateX(100%);");
    expect(keyframes("sa-bw-out-left")).toContain("transform: translateX(-100%);");
    expect(keyframes("sa-bw-out-right")).toContain("transform: translateX(100%);");
    // A word moved by its own (the band's) height is right out of the band.
    expect(block(".sa-bw-word").get("height")).toBe("100%");
    expect(keyframes("sa-bw-tick-out")).toContain("transform: translateY(-100%);");
    expect(block('.sa-bw-word[data-word="to"]').get("transform")).toBe("translateY(100%)");
    // Each word sized on its own, big on a phone; min() has a plain fallback declared first
    // (older iOS).
    for (const [side, size] of [
      ["from", ["24vw", "min(24vw, 16vh)"]],
      ["to", ["14.5vw", "min(14.5vw, 14vh)"]],
    ] as const) {
      const rule = section().slice(section().indexOf(`.sa-bw-word[data-word="${side}"] {`));
      const body = rule.slice(0, rule.indexOf("}"));
      expect(body.indexOf(`font-size: ${size[0]};`)).toBeGreaterThan(0);
      expect(body.indexOf(`font-size: ${size[0]};`)).toBeLessThan(
        body.indexOf(`font-size: ${size[1]};`),
      );
    }
    // The band is 20% of the screen: the capped words fit inside it.
    expect(block(".sa-bw-word").get("font-size")).toBeUndefined();
    expect(block(".sa-bw-label").get("padding")).toBe("0.08em 0.22em");
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
    // No lift like the current look's: the bands leave sideways, the way they came.
    expect(s).not.toMatch(/sa-switch-flood/);
    // Going out in the full show is forwards only (a backwards fill would empty the screen at 0ms).
    const outs = [...s.matchAll(/sa-bw-out-\w+ \d+ms cubic-bezier\([^)]*\) (\d+)ms (\w+)/g)];
    expect(outs.length).toBe(bw.BW_BANDS);
    for (const m of outs) expect(m[2]).toBe("forwards");
    // The words only show in the full show.
    expect(block(".sa-bw-words").get("display")).toBe("none");
    expect(s).not.toMatch(/data-sa-switching="(out|in-quiet)"\][^{]*\.sa-bw-(words|word)/);
  });

  it("the markup carries no class of another look, so their rules can't reach it", () => {
    const src = readFileSync("src/components/marketing/growth/looks/big-words.tsx", "utf8");
    const classes = (src.match(/className="[^"]*"/g) ?? []).join(" ");
    expect(classes).toContain("sa-bw-band");
    expect(classes).toContain("sa-headline-serif");
    expect(classes).toContain("sa-headline-heavy");
    expect(classes).not.toMatch(/sa-switch-|sa-ls-|sa-cu-|sa-td-/);
    expect(src).toContain("data-sa-switch-graphic");
    expect(src).not.toMatch(/role=|tabIndex|aria-pressed|onClick|<button|<a /);
  });
});
