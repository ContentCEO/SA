import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as rules from "@/components/marketing/growth/switch-rules";
import {
  jumpMode,
  nextMode,
  rootHeight,
  rootMarginFor,
  switchPath,
  tapPlaysShow,
} from "@/components/marketing/growth/switch-rules";

/**
 * The homepage switch from the app to Squared Away Growth: rules and the theme swap in the CSS.
 * The show itself ("Big words") is checked in growth-big-words.test.ts.
 */

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

  it("keeps its settle and navigation windows", () => {
    expect(rules.SETTLE_MS).toBe(500);
    expect(rules.NAV_MS).toBe(1000);
  });

  it("is pure: no server-only, no database, no DOM", () => {
    const src = readFileSync("src/components/marketing/growth/switch-rules.ts", "utf8");
    expect(src).not.toMatch(/server-only|@\/db|document\.|window\.|import /);
  });
});

describe("switchPath: the full show on every move from the app into Growth", () => {
  it("every move into Growth plays the full show, however many came before", () => {
    // No memory: the tenth crossing plays exactly like the first.
    for (let i = 0; i < 10; i++) expect(switchPath("growth", false, false)).toBe("in");
  });

  it("the way back up is always the quiet wipe", () => {
    expect(switchPath("app", false, false)).toBe("out");
    expect(switchPath("app", false, true)).toBe("out");
  });

  it("a decision that waited for a show or wipe plays quietly: one show at a time", () => {
    expect(switchPath("growth", false, true)).toBe("in-quiet");
  });

  it("instant beats everything: navigation, a hidden tab, reduced motion, an unsettled page", () => {
    for (const next of ["app", "growth"] as const) {
      for (const queued of [false, true]) expect(switchPath(next, true, queued)).toBe("instant");
    }
  });
});

describe("tapPlaysShow: a #growth tap from the app side plays the show, every time", () => {
  const tap = {
    href: "#growth",
    pointer: true,
    mode: "app",
    playing: false,
    instant: false,
  } as const;

  it("a pointer tap on #growth from the app side plays it, again and again", () => {
    for (let i = 0; i < 5; i++) expect(tapPlaysShow(tap)).toBe(true);
  });

  it("in Growth a tap is a plain jump to the opener", () => {
    expect(tapPlaysShow({ ...tap, mode: "growth" })).toBe(false);
  });

  it("never while something plays, when the switch is instant, from the keyboard or elsewhere", () => {
    expect(tapPlaysShow({ ...tap, playing: true })).toBe(false);
    expect(tapPlaysShow({ ...tap, instant: true })).toBe(false);
    expect(tapPlaysShow({ ...tap, pointer: false })).toBe(false);
    for (const href of ["#growth-call", "#pricing", "#waitlist", "#", "/growth", "#Growth"]) {
      expect(tapPlaysShow({ ...tap, href }), href).toBe(false);
    }
  });
});

describe("GrowthSwitch: no once-per-page limit and no look chooser", () => {
  const src = readFileSync("src/components/marketing/growth/growth-switch.tsx", "utf8");

  it("decides every path with switchPath / tapPlaysShow, with nothing that remembers a show", () => {
    expect(src).toContain("switchPath(");
    expect(src).toContain("tapPlaysShow(");
    expect(src).not.toMatch(/playedFull|playedOnce|hasPlayed|sessionStorage|localStorage/);
  });

  it("reads no ?look= and sets no data-sa-look", () => {
    expect(src).not.toMatch(/look|useSyncExternalStore|location\.search/i);
  });

  it("flushes the stage's style on every path, before any path is set", () => {
    // A queued path starts in the same task the last one ended, on the same sa-bw-out-* keyframes:
    // without the flush its bands keep the finished animations and never show (e2e checks it too).
    const play = src.slice(src.indexOf("const play = "), src.indexOf("const go = "));
    const flush = play.indexOf("stage?.getBoundingClientRect()");
    expect(flush).toBeGreaterThan(-1);
    expect(play.match(/getBoundingClientRect\(\)/g)).toHaveLength(1);
    expect(flush).toBeLessThan(play.indexOf('if (path === "in")'));
    expect(flush).toBeLessThan(play.indexOf("root.setAttribute(SWITCHING"));
  });
});

describe("theme.css: the switch", () => {
  it("uses no scroll timelines, no old flip, no clip-path and none of the old covers", () => {
    for (const banned of [
      "animation-timeline",
      "view-timeline",
      "sa-flip",
      "clip-path",
      "sa-switch-flood",
      "sa-switch-knob",
      "data-sa-look",
    ]) {
      expect(css).not.toContain(banned);
    }
    // None of the other candidate looks' classes are left behind.
    expect(css).not.toMatch(/\.sa-(ls|cu|td|bl)-/);
  });

  it("writes each brand colour once, as a constant on :root", () => {
    const hexes = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/#[0-9a-f]{3,8}\b/gi) ?? [];
    expect(hexes.map((h) => h.toLowerCase()).sort()).toEqual(
      [
        ...["#1b1b1b", "#efeeea", "#f7f6f3", "#d9d7d0", "#9a9994", "#5e5d59", "#262625"],
        // Sunlight mode (plan #37, signed-in app only): its own constants, also written once.
        ...["#111111", "#fffef9", "#000000"],
      ].sort(),
    );
    for (const [name, hex] of [
      ["hc-charcoal", "#111111"],
      ["hc-offwhite", "#fffef9"],
      ["hc-black", "#000000"],
    ]) {
      expect(css).toContain(`--sa-k-${name}: ${hex};`);
    }
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
