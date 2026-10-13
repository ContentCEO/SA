import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { lookFor } from "@/components/marketing/growth/looks";
import * as bl from "@/components/marketing/growth/looks/blinds-rules";
import * as rules from "@/components/marketing/growth/switch-rules";

/** Look 5, "Blinds" (TEMPORARY `?look=5` preview): its clock and the CSS that plays it. */

const css = readFileSync("src/styles/theme.css", "utf8");
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
const LOOK = ':root[data-sa-look="5"]';
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
  const start = bare.indexOf(".sa-bl-blind {");
  const end = bare.indexOf("@media (prefers-reduced-motion: reduce)", start);
  return bare.slice(start, end);
}
const SLATS = Array.from({ length: bl.BL_SLATS }, (_, i) => i);
const EASE_QUIET = "cubic-bezier(0.65, 0, 0.35, 1)";

describe("look 5 (blinds): timings", () => {
  it("is registered as look 5 with its own clock; the quiet paths keep OUT_DONE_MS", () => {
    const look = lookFor("5");
    expect(look.id).toBe("5");
    expect(look.timing).toEqual({
      themeAtMs: bl.BL_THEME_AT_MS,
      realignAtMs: bl.BL_REALIGN_AT_MS,
      doneMs: bl.BL_DONE_MS,
      quietDoneMs: rules.OUT_DONE_MS,
    });
  });

  it("keeps its pinned values", () => {
    expect([
      bl.BL_SLATS,
      bl.BL_OPEN_SCALE,
      bl.BL_DROP_MS,
      bl.BL_SHUT_AT_MS,
      bl.BL_SHUT_MS,
      bl.BL_COVERED_AT_MS,
      bl.BL_THEME_AT_MS,
      bl.BL_TILT_AT_MS,
      bl.BL_TILT_MS,
      bl.BL_CHIP_AT_MS,
      bl.BL_REALIGN_AT_MS,
      bl.BL_OPEN_AT_MS,
      bl.BL_OPEN_MS,
      bl.BL_DONE_MS,
    ]).toEqual([8, 0.18, 280, 280, 160, 440, 540, 580, 240, 700, 1220, 1300, 240, 1740]);
    expect(SLATS.map(bl.slatTopPct)).toEqual([0, 12.5, 25, 37.5, 50, 62.5, 75, 87.5]);
  });

  it("dropped, shut, swap, tilt, chip, a held label, open, under 2s", () => {
    // The slats only shut once the blind is all the way down.
    expect(bl.BL_SHUT_AT_MS).toBeGreaterThanOrEqual(bl.BL_DROP_MS);
    // The theme swaps once every slat is shut, with 100ms to spare: the slats' CSS clock starts
    // at the first painted frame, the timer when the attribute is set, so on a slow phone the
    // slats can trail the timer (gaps between half-shut slats would show the swap).
    expect(bl.BL_COVERED_AT_MS + 100).toBeLessThanOrEqual(bl.BL_THEME_AT_MS);
    // The tilt starts after the swap, over the backing.
    expect(bl.BL_TILT_AT_MS).toBeGreaterThan(bl.BL_THEME_AT_MS);
    expect(bl.BL_CHIP_AT_MS).toBe(bl.BL_TILT_AT_MS + bl.BL_TILT_MS / 2);
    expect(bl.BL_THEME_AT_MS).toBeLessThan(bl.BL_REALIGN_AT_MS);
    expect(bl.BL_REALIGN_AT_MS).toBeLessThan(bl.BL_OPEN_AT_MS);
    // The tilt is over well before the slats open.
    expect(bl.BL_TILT_AT_MS + bl.BL_TILT_MS).toBeLessThan(bl.BL_REALIGN_AT_MS);
    // "One-on-one" holds, inverted, for 600ms or more before the slats open.
    expect(bl.BL_OPEN_AT_MS - bl.BL_CHIP_AT_MS).toBeGreaterThanOrEqual(600);
    // The exit ends where the other looks' do.
    expect(bl.BL_OPEN_AT_MS + bl.BL_OPEN_MS).toBe(1540);
    // Cleanup after the slats are open and the headline has landed (open + 40 + 60 + 300ms).
    expect(bl.BL_DONE_MS).toBeGreaterThan(bl.BL_OPEN_AT_MS + bl.BL_OPEN_MS);
    expect(bl.BL_DONE_MS).toBeGreaterThan(bl.BL_OPEN_AT_MS + rules.LAND_AFTER_LIFT_MS + 360);
    expect(bl.BL_DONE_MS).toBeLessThan(2000);
  });

  it("the rules file is pure: no server-only, no database, no DOM", () => {
    const src = readFileSync("src/components/marketing/growth/looks/blinds-rules.ts", "utf8");
    expect(src).not.toMatch(/server-only|@\/db|document\.|window\.|import /);
  });
});

describe("look 5 (blinds): theme.css", () => {
  it("the animations use the timings in blinds-rules.ts", () => {
    expect(anim(`${sw("in")} .sa-bl-blind`)).toBe(
      `sa-bl-drop ${bl.BL_DROP_MS}ms cubic-bezier(0.5, 0, 0.2, 1) both`,
    );
    expect(anim(`${sw("in")} .sa-bl-slat`)).toBe(
      `sa-bl-shut ${bl.BL_SHUT_MS}ms cubic-bezier(0.4, 0, 0.2, 1) ${bl.BL_SHUT_AT_MS}ms both, ` +
        `sa-bl-tilt ${bl.BL_TILT_MS}ms linear ${bl.BL_TILT_AT_MS}ms forwards, ` +
        `sa-bl-open ${bl.BL_OPEN_MS}ms ${EASE_QUIET} ${bl.BL_OPEN_AT_MS}ms forwards`,
    );
    expect(anim(`${sw("out")} .sa-bl-slat,\n${sw("in-quiet")} .sa-bl-slat`)).toBe(
      `sa-bl-open ${rules.QUIET_MS}ms ${EASE_QUIET} both`,
    );
    // On under the shut slats; off as they open, so the opener shows through.
    expect(anim(`${sw("in")} .sa-bl-back`)).toBe(
      `sa-switch-edge-on 1ms linear ${bl.BL_COVERED_AT_MS}ms forwards, ` +
        `sa-switch-edge-off 1ms linear ${bl.BL_OPEN_AT_MS}ms forwards`,
    );
    // The title is printed on the slats only once they're shut.
    expect(block(".sa-bl-card").get("opacity")).toBe("0");
    expect(anim(`${sw("in")} .sa-bl-card`)).toBe(
      `sa-switch-edge-on 1ms linear ${bl.BL_COVERED_AT_MS}ms forwards`,
    );
    expect(anim(`${sw("in")} .sa-bl-label[data-label="from"] .sa-bl-chip`)).toBe(
      `sa-switch-edge-off 1ms linear ${bl.BL_CHIP_AT_MS}ms forwards`,
    );
    expect(anim(`${sw("in")} .sa-bl-label[data-label="to"] .sa-bl-chip`)).toBe(
      `sa-switch-edge-on 1ms linear ${bl.BL_CHIP_AT_MS}ms forwards`,
    );
    // One word: the two share a place and swap, chip and all, in the same frame.
    expect(anim(`${sw("in")} .sa-bl-label[data-label="from"]`)).toBe(
      `sa-switch-edge-off 1ms linear ${bl.BL_CHIP_AT_MS}ms forwards`,
    );
    expect(anim(`${sw("in")} .sa-bl-label[data-label="to"]`)).toBe(
      `sa-switch-edge-on 1ms linear ${bl.BL_CHIP_AT_MS}ms forwards`,
    );
    expect(block('.sa-bl-label[data-label="to"]').get("opacity")).toBe("0");
    expect(block(".sa-bl-label").get("grid-row")).toBe("1");
    expect(block(".sa-bl-label").get("grid-column")).toBe("1");
    // As wide as a phone allows, and at most 8.5vh, so each chip sits inside its own slat
    // (12.5vh); min() has a fallback first.
    for (const [side, vw] of [
      ["from", "24vw"],
      ["to", "14.5vw"],
    ] as const) {
      const rule = section().slice(section().indexOf(`.sa-bl-label[data-label="${side}"] {`));
      const body = rule.slice(0, rule.indexOf("}"));
      expect(body.indexOf(`font-size: ${vw};`)).toBeGreaterThan(0);
      expect(body.indexOf(`font-size: ${vw};`)).toBeLessThan(
        body.indexOf(`font-size: min(${vw}, 8.5vh);`),
      );
    }
    const land = bl.BL_OPEN_AT_MS + rules.LAND_AFTER_LIFT_MS - bl.BL_THEME_AT_MS;
    const landSel = `${LOOK}[data-sa-theme="growth"][data-sa-switching="in"] .sa-land > span`;
    expect(block(landSel).get("animation-delay")).toBe(`${land}ms`);
    expect(block(`${landSel} + span`).get("animation-delay")).toBe(`${land + 60}ms`);

    expect(block(".sa-bl-slat").get("background-color")).toBe("var(--sa-k-charcoal)");
    // Its own rule (the selector also ends the shared display rule above it).
    expect(section()).toMatch(/\n\.sa-bl-back \{[^}]*background-color: var\(--sa-k-charcoal\);/);
    // Its own rule (the selector also heads the shared quiet-path rule above it).
    expect(bare).toContain(
      `\n${sw("in-quiet")} .sa-bl-slat {\n  background-color: var(--sa-k-paper);\n` +
        `  box-shadow: 0 1px 0 var(--sa-k-paper);\n}`,
    );
    // The slats start open (as thick as BL_OPEN_SCALE) and shut to full height.
    expect(keyframes("sa-bl-shut")).toContain(`transform: scaleY(${bl.BL_OPEN_SCALE});`);
    expect(keyframes("sa-bl-shut")).toContain("transform: scaleY(1);");
    expect(keyframes("sa-bl-drop")).toContain("transform: translateY(-100%);");
    expect(keyframes("sa-bl-open")).toContain("transform: scaleY(0);");
    // The tilt is edge-on halfway, where the chip moves.
    expect(keyframes("sa-bl-tilt")).toMatch(/50% \{\s*transform: scaleY\(0\.\d+\);/);
  });

  it("the timing comment matches blinds-rules.ts", () => {
    for (const name of ["BL_THEME_AT_MS", "BL_REALIGN_AT_MS", "BL_DONE_MS"] as const) {
      const m = css.match(new RegExp(`${name} = (\\d+)`));
      expect(m, name).not.toBeNull();
      expect(Number(m![1])).toBe(bl[name]);
    }
  });

  it("eight slats tile the screen exactly, a 1px shadow closing any gap; a word on each", () => {
    // Exactly an eighth: no slat carries a row of the next one's title.
    expect(block(".sa-bl-slat").get("height")).toBe("12.5%");
    // The gap is closed by the slat's own colour, outside its clip, carrying no content.
    expect(block(".sa-bl-slat").get("box-shadow")).toBe("0 1px 0 var(--sa-k-charcoal)");
    // (The quiet paper slats' own shadow is checked with their colour above.)
    expect(block(".sa-bl-slat").get("overflow")).toBe("hidden");
    // Each slat's own word fills the slat (no copy offset across the screen).
    expect(block(".sa-bl-card").get("height")).toBe("100%");
    expect(block(".sa-bl-card").get("top")).toBe("0");
    expect(section()).not.toMatch(/\.sa-bl-slat\[data-slat="\d"\] \.sa-bl-card/);
    for (const i of SLATS) {
      const pct = bl.slatTopPct(i);
      expect(block(`.sa-bl-slat[data-slat="${i}"]`).get("top")).toBe(i === 0 ? "0" : `${pct}%`);
    }
    // Centred in its slat.
    expect(block(".sa-bl-title").get("top")).toBe("50%");
    expect(block(".sa-bl-title").get("transform")).toBe("translateY(-50%)");
  });

  it("transforms and 1ms flips only: no clips, no fades, two tones from the theme constants", () => {
    const s = section();
    expect(s.length).toBeGreaterThan(1000);
    expect(s).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|gradient|blur|filter|clip-path/i);
    // The only shadows are the slats' 1px gap closers, in the slat's own colour.
    for (const m of s.matchAll(/box-shadow: ([^;]*);/g)) {
      expect(m[1]).toMatch(/^0 1px 0 var\(--sa-k-(charcoal|paper)\)$/);
    }
    expect(s).not.toMatch(/text-shadow|drop-shadow/);
    expect(s).not.toMatch(/\binset:/);
    expect(s).not.toMatch(/transition/);
    for (const v of s.match(/var\(--[a-z-]+\)/g) ?? []) {
      expect(["var(--sa-k-charcoal)", "var(--sa-k-offwhite)", "var(--sa-k-paper)"]).toContain(v);
    }
    for (const m of s.matchAll(/sa-switch-edge-(?:on|off) (\d+)ms/g)) expect(m[1]).toBe("1");
    // No lift like the current look's: the slats tilt open instead.
    expect(s).not.toMatch(/sa-switch-flood/);
    // Opening in the full show is forwards only (a backwards fill would open them from 0ms).
    const opens = [...s.matchAll(/sa-bl-open \d+ms cubic-bezier\([^)]*\) (\d+)ms (\w+)/g)];
    expect(opens.length).toBe(1);
    for (const m of opens) expect(m[2]).toBe("forwards");
    // The tilt is forwards only too: a backwards fill would hold scaleY(1) and skip the drop.
    expect(s).toMatch(/sa-bl-tilt \d+ms linear \d+ms forwards[,;]/);
    // The title and backing only show in the full show.
    expect(block(".sa-bl-card,\n.sa-bl-back").get("display")).toBe("none");
    expect(s).not.toMatch(
      /data-sa-switching="(out|in-quiet)"\][^{]*\.sa-bl-(card|title|label|chip|back)/,
    );
  });

  it("the markup carries no class of another look, so their rules can't reach it", () => {
    const src = readFileSync("src/components/marketing/growth/looks/blinds.tsx", "utf8");
    const classes = (src.match(/className="[^"]*"/g) ?? []).join(" ");
    expect(classes).toContain("sa-bl-slat");
    expect(classes).toContain("sa-headline-serif");
    expect(classes).toContain("sa-headline-heavy");
    expect(classes).not.toMatch(/sa-switch-|sa-ls-|sa-cu-|sa-td-|sa-bw-/);
    expect(src).toContain("data-sa-switch-graphic");
    expect(src).not.toMatch(/role=|tabIndex|aria-pressed|onClick|<button|<a |style=/);
  });
});
