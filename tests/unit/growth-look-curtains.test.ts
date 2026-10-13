import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lookFor } from "@/components/marketing/growth/looks";
import * as cu from "@/components/marketing/growth/looks/curtains-rules";
import * as rules from "@/components/marketing/growth/switch-rules";

/** Look 2, "Curtains" (TEMPORARY `?look=2` preview): its clock and the CSS that plays it. */

const css = readFileSync("src/styles/theme.css", "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const LOOK = ':root[data-sa-look="2"]';
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
const anim = (sel: string) => block(sel).get("animation") ?? "";
/** The look's own CSS: from its first rule to the start of the next section. */
function section(): string {
  const start = bare.indexOf(".sa-cu-stage {");
  // Look 3's block follows this one.
  const end = bare.indexOf(".sa-td-water {", start);
  return bare.slice(start, end);
}

describe("look 2 (curtains): timings", () => {
  it("is registered as look 2 with its own clock; the quiet paths keep OUT_DONE_MS", () => {
    const look = lookFor("2");
    expect(look.id).toBe("2");
    expect(look.timing).toEqual({
      themeAtMs: cu.CURTAIN_THEME_AT_MS,
      realignAtMs: cu.CURTAIN_REALIGN_AT_MS,
      doneMs: cu.CURTAIN_DONE_MS,
      quietDoneMs: rules.OUT_DONE_MS,
    });
  });

  it("keeps its pinned values", () => {
    expect([
      cu.CURTAIN_CLOSE_MS,
      cu.CURTAIN_THEME_AT_MS,
      cu.CURTAIN_CHIP_AT_MS,
      cu.CURTAIN_REALIGN_AT_MS,
      cu.CURTAIN_OPEN_AT_MS,
      cu.CURTAIN_OPEN_MS,
      cu.CURTAIN_DONE_MS,
      cu.CURTAIN_EDGE_OFF_AT_MS,
      cu.CURTAIN_EDGE_ON_AT_MS,
    ]).toEqual([360, 420, 520, 1180, 1260, 300, 1740, 300, 1380]);
  });

  it("the two off-white edges never sit together on the seam (no bright bar at 375px)", () => {
    // How far a CSS cubic-bezier(x1, y1, x2, y2) has got at time fraction t.
    const bezier = (x1: number, y1: number, x2: number, y2: number, t: number) => {
      const at = (a: number, b: number, s: number) =>
        3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3;
      let lo = 0;
      let hi = 1;
      for (let i = 0; i < 60; i++) {
        const mid = (lo + hi) / 2;
        if (at(x1, x2, mid) < t) lo = mid;
        else hi = mid;
      }
      return at(y1, y2, (lo + hi) / 2);
    };
    const width = 375;
    // Closing (each half from ±100% to 0): the gap between them as the edges switch off.
    const shut = bezier(0.6, 0, 0.2, 1, cu.CURTAIN_EDGE_OFF_AT_MS / cu.CURTAIN_CLOSE_MS);
    expect(width * (1 - shut)).toBeGreaterThanOrEqual(6);
    expect(cu.CURTAIN_EDGE_OFF_AT_MS).toBeLessThan(cu.CURTAIN_CLOSE_MS);
    // From then on the seam fills the gap still left between them, on any screen width (the gap
    // is a share of the width, and so is the seam).
    // Its own rule (the selector also ends the shared display rule above it).
    expect(section()).toMatch(/\n\.sa-cu-seam \{[^}]*left: 48%;\s*width: 4%;/);
    expect(100 * (1 - shut)).toBeLessThan(4);
    // Opening: the gap as the edges come back.
    const open = bezier(
      0.5,
      0,
      0.75,
      0,
      (cu.CURTAIN_EDGE_ON_AT_MS - cu.CURTAIN_OPEN_AT_MS) / cu.CURTAIN_OPEN_MS,
    );
    expect(width * open).toBeGreaterThanOrEqual(6);
    expect(cu.CURTAIN_EDGE_ON_AT_MS).toBeLessThan(cu.CURTAIN_OPEN_AT_MS + cu.CURTAIN_OPEN_MS);
  });

  it("shut, swap under full cover, chip, a held label, open, under 2s", () => {
    // The theme swaps once the curtains are shut, with a frame or two to spare.
    expect(cu.CURTAIN_CLOSE_MS + 40).toBeLessThanOrEqual(cu.CURTAIN_THEME_AT_MS);
    expect(cu.CURTAIN_CHIP_AT_MS).toBeGreaterThan(cu.CURTAIN_THEME_AT_MS);
    expect(cu.CURTAIN_THEME_AT_MS).toBeLessThan(cu.CURTAIN_REALIGN_AT_MS);
    expect(cu.CURTAIN_REALIGN_AT_MS).toBeLessThan(cu.CURTAIN_OPEN_AT_MS);
    // "One-on-one" holds, inverted, for 600ms or more before the curtains open.
    expect(cu.CURTAIN_OPEN_AT_MS - cu.CURTAIN_CHIP_AT_MS).toBeGreaterThanOrEqual(600);
    // Cleanup after the curtains are open and the headline has landed (open + 40 + 60 + 300ms).
    expect(cu.CURTAIN_DONE_MS).toBeGreaterThan(cu.CURTAIN_OPEN_AT_MS + cu.CURTAIN_OPEN_MS);
    expect(cu.CURTAIN_DONE_MS).toBeGreaterThan(
      cu.CURTAIN_OPEN_AT_MS + rules.LAND_AFTER_LIFT_MS + 360,
    );
    expect(cu.CURTAIN_DONE_MS).toBeLessThan(2000);
  });

  it("the rules file is pure: no server-only, no database, no DOM", () => {
    const src = readFileSync("src/components/marketing/growth/looks/curtains-rules.ts", "utf8");
    expect(src).not.toMatch(/server-only|@\/db|document\.|window\.|import /);
  });
});

describe("look 2 (curtains): theme.css", () => {
  it("the animations use the timings in curtains-rules.ts", () => {
    for (const side of ["left", "right"]) {
      expect(anim(`${sw("in")} .sa-cu-half[data-side="${side}"]`)).toBe(
        `sa-cu-close-${side} ${cu.CURTAIN_CLOSE_MS}ms cubic-bezier(0.6, 0, 0.2, 1) both, ` +
          `sa-cu-open-${side} ${cu.CURTAIN_OPEN_MS}ms cubic-bezier(0.5, 0, 0.75, 0) ${cu.CURTAIN_OPEN_AT_MS}ms forwards`,
      );
      expect(
        anim(
          `${sw("out")} .sa-cu-half[data-side="${side}"],\n${sw("in-quiet")} .sa-cu-half[data-side="${side}"]`,
        ),
      ).toBe(`sa-cu-open-${side} ${rules.QUIET_MS}ms cubic-bezier(0.65, 0, 0.35, 1) both`);
    }
    expect(anim(`${sw("in")} .sa-cu-edge`)).toBe(
      `sa-switch-edge-off 1ms linear ${cu.CURTAIN_EDGE_OFF_AT_MS}ms forwards, ` +
        `sa-switch-edge-on 1ms linear ${cu.CURTAIN_EDGE_ON_AT_MS}ms forwards`,
    );
    // The seam comes on as the edges go off (the close's last few px), off as they open.
    expect(anim(`${sw("in")} .sa-cu-seam`)).toBe(
      `sa-switch-edge-on 1ms linear ${cu.CURTAIN_EDGE_OFF_AT_MS}ms forwards, ` +
        `sa-switch-edge-off 1ms linear ${cu.CURTAIN_OPEN_AT_MS}ms forwards`,
    );
    // One word, "One-on-one", inverts in one frame.
    expect(block(".sa-cu-chip").get("opacity")).toBe("0");
    expect(anim(`${sw("in")} .sa-cu-chip`)).toBe(
      `sa-switch-edge-on 1ms linear ${cu.CURTAIN_CHIP_AT_MS}ms forwards`,
    );
    const land = cu.CURTAIN_OPEN_AT_MS + rules.LAND_AFTER_LIFT_MS - cu.CURTAIN_THEME_AT_MS;
    const landSel = `${LOOK}[data-sa-theme="growth"][data-sa-switching="in"] .sa-land > span`;
    expect(block(landSel).get("animation-delay")).toBe(`${land}ms`);
    expect(block(`${landSel} + span`).get("animation-delay")).toBe(`${land + 60}ms`);

    expect(block(".sa-cu-half").get("background-color")).toBe("var(--sa-k-charcoal)");
    expect(block(`${sw("in-quiet")} .sa-cu-half`).get("background-color")).toBe(
      "var(--sa-k-paper)",
    );
  });

  it("the timing comment matches curtains-rules.ts", () => {
    for (const name of [
      "CURTAIN_THEME_AT_MS",
      "CURTAIN_REALIGN_AT_MS",
      "CURTAIN_DONE_MS",
    ] as const) {
      const m = css.match(new RegExp(`${name} = (\\d+)`));
      expect(m, name).not.toBeNull();
      expect(Number(m![1])).toBe(cu[name]);
    }
  });

  it("the halves start off screen and their copies of the title line up when shut", () => {
    expect(block('.sa-cu-half[data-side="left"]').get("transform")).toBe("translateX(-100%)");
    expect(block('.sa-cu-half[data-side="right"]').get("transform")).toBe("translateX(100%)");
    expect(block('.sa-cu-half[data-side="left"]').get("width")).toBe("50%");
    expect(block('.sa-cu-half[data-side="right"]').get("left")).toBe("50%");
    expect(block(".sa-cu-half").get("overflow")).toBe("hidden");
    expect(block(".sa-cu-card").get("width")).toBe("200%");
    expect(block('.sa-cu-half[data-side="left"] .sa-cu-card').get("left")).toBe("0");
    expect(block('.sa-cu-half[data-side="right"] .sa-cu-card').get("left")).toBe("-100%");
    const title = section().slice(section().indexOf(".sa-cu-title {"));
    expect(title.indexOf("top: 50%;")).toBeLessThan(title.indexOf("top: 50svh;"));
    // One huge word, big on a phone; min() has a plain fallback declared first (older iOS).
    const label = section().slice(section().indexOf(".sa-cu-label {"));
    expect(label.indexOf("font-size: 30vw;")).toBeGreaterThan(0);
    expect(label.indexOf("font-size: 30vw;")).toBeLessThan(
      label.indexOf("font-size: min(30vw, 19vh);"),
    );
    // Stacked a part per line, the inverted block too.
    expect(block(".sa-cu-line").get("display")).toBe("block");
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
    // Every opacity animation is a 1ms flip.
    for (const m of s.matchAll(/sa-switch-edge-(?:on|off) (\d+)ms/g)) expect(m[1]).toBe("1");
    // The opening is forwards only (a backwards fill would hold the curtains open from 0ms).
    for (const m of s.matchAll(/sa-cu-open-\w+ \d+ms [^,;]* (\d+)ms (\w+)/g)) {
      expect(m[2]).toBe("forwards");
    }
    // The title, edges and seam only show in the full show.
    expect(block(".sa-cu-card,\n.sa-cu-edge,\n.sa-cu-seam").get("display")).toBe("none");
    expect(s).not.toMatch(
      /data-sa-switching="(out|in-quiet)"\][^{]*\.sa-cu-(card|edge|seam|title)/,
    );
  });

  it("the markup carries no class of the current look, so its unscoped rules can't reach it", () => {
    const src = readFileSync("src/components/marketing/growth/looks/curtains.tsx", "utf8");
    const classes = (src.match(/className="[^"]*"/g) ?? []).join(" ");
    expect(classes).toContain("sa-cu-half");
    // One heavy word now: no stacked serif line.
    expect(classes).toContain("sa-headline-heavy");
    expect(src).not.toContain('data-label="from"');
    expect(classes).not.toMatch(/sa-switch-|sa-ls-/);
    expect(src).toContain("data-sa-switch-graphic");
    expect(src).not.toMatch(/role=|tabIndex|aria-pressed|onClick|<button|<a /);
  });
});
