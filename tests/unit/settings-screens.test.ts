import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SCREEN_MESSAGES, LIST_MESSAGES } from "@/app/(app)/settings/messages";
import { LEGACY_SETTINGS_IDS, legacySettingsScreen } from "@/app/(app)/settings/legacy-anchors";
import { fillCounts } from "@/app/(app)/settings/screen";
import { currentTab } from "@/config/nav";

/** Outside review (I4): Settings is a list of short screens. */
const SETTINGS = join("src", "app", "(app)", "settings");
const pageFor = (path: string) =>
  join("src", "app", "(app)", ...path.replace(/^\//, "").split("/"), "page.tsx");

const SOURCES = [
  ...readdirSync(SETTINGS)
    .filter((f) => f.endsWith("actions.ts"))
    .map((f) => join(SETTINGS, f)),
  join("src", "app", "api", "gmail", "callback", "route.ts"),
];

/** Every "/settings…?done=x" / "?error=x" written in a settings action or the Gmail callback. */
function redirectsIn(src: string): { path: string; kind: "done" | "error"; code: string }[] {
  return [...src.matchAll(/["`](\/settings[^"`?#]*)\?(done|error)=([a-z_]+)(?=["`])/g)].map(
    (m) => ({
      path: m[1]!,
      kind: m[2] as "done" | "error",
      code: m[3]!,
    }),
  );
}

describe("settings redirects", () => {
  const found = SOURCES.flatMap((f) => redirectsIn(readFileSync(f, "utf8")));

  it("finds them (the scan isn't silently empty)", () => {
    expect(found.length).toBeGreaterThanOrEqual(25);
  });

  it("each lands on a screen that exists and has a notice for its code", () => {
    for (const r of found) {
      expect(r.path, `${r.path}?${r.kind}=${r.code}`).not.toBe("/settings");
      expect(existsSync(pageFor(r.path)), pageFor(r.path)).toBe(true);
      const messages = SCREEN_MESSAGES[r.path as keyof typeof SCREEN_MESSAGES];
      expect(messages, r.path).toBeDefined();
      expect(
        (messages[r.kind] as Record<string, string>)[r.code],
        `${r.path}?${r.kind}=${r.code}`,
      ).toBeTruthy();
    }
  });

  it("text-alert refusals (built from the error's code) each have a notice", () => {
    const src = readFileSync(join(SETTINGS, "sms-actions.ts"), "utf8");
    expect(src).toContain("const back = (q: string) => `/settings/texts?${q}`;");
    expect(src).toContain("redirect(back(`error=sms_${err.code}`))");
    const codes = readFileSync("src/server/sms-alerts.ts", "utf8")
      .match(/readonly code: ([^,]+),/)![1]!
      .match(/"([a-z_]+)"/g)!
      .map((c) => c.replace(/"/g, ""));
    expect(codes.length).toBeGreaterThanOrEqual(5);
    for (const c of codes)
      expect(SCREEN_MESSAGES["/settings/texts"].error).toHaveProperty(`sms_${c}`);
    for (const ok of ["sms_code", "sms_on", "sms_off", "sms_removed"])
      expect(src).toContain(`"${ok}"`);
  });

  it("seasonal-note refusals (built from the error's code) each have a notice", () => {
    const codes = readFileSync("src/server/seasonal-notes.ts", "utf8")
      .match(/readonly code: ([^,]+),/)![1]!
      .match(/"([a-z_]+)"/g)!
      .map((c) => c.replace(/"/g, ""));
    for (const c of codes)
      expect(SCREEN_MESSAGES["/settings/business"].error).toHaveProperty(`note_${c}`);
  });

  it("every screen with messages has a page", () => {
    for (const path of Object.keys(SCREEN_MESSAGES))
      expect(existsSync(pageFor(path)), path).toBe(true);
  });

  it("old bookmarks (/settings?done=…) still read the same on the list", () => {
    for (const code of ["connected", "profile", "digest", "followups", "hand", "sms_on"])
      expect(LIST_MESSAGES.done[code], code).toBeTruthy();
    for (const code of ["delete_billing", "limit", "relearn_busy"])
      expect(LIST_MESSAGES.error[code], code).toBeTruthy();
    expect(LIST_MESSAGES.done.saved).toBeUndefined();
  });

  it("no screen under /settings uses notFound() (its loading.tsx would turn the 404 into 200)", () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
        d.isDirectory()
          ? walk(join(dir, d.name))
          : d.name === "page.tsx"
            ? [join(dir, d.name)]
            : [],
      );
    for (const f of walk(SETTINGS)) expect(readFileSync(f, "utf8"), f).not.toContain("notFound(");
  });

  it("Text alerts and Notifications stay hidden until they're set up", () => {
    const list = readFileSync(join(SETTINGS, "page.tsx"), "utf8");
    expect(list).toMatch(
      /if \(smsConfigured\(\)\) \{\s*items\.push\(\{\s*href: "\/settings\/texts"/,
    );
    expect(list).toMatch(
      /if \(vapidPublicKey\(\)\) \{\s*items\.push\(\{\s*href: "\/settings\/notifications"/,
    );
    expect(readFileSync(join(SETTINGS, "texts", "page.tsx"), "utf8")).toContain(
      'if (!smsConfigured()) redirect("/settings");',
    );
    expect(readFileSync(join(SETTINGS, "notifications", "page.tsx"), "utf8")).toContain(
      'if (!key) redirect("/settings");',
    );
    for (const f of [join(SETTINGS, "page.tsx"), join(SETTINGS, "texts", "page.tsx")])
      expect(readFileSync(f, "utf8")).not.toContain("Coming soon");
  });

  it("the never-say notice fills in counts only (Check 15 P5)", () => {
    const msg = SCREEN_MESSAGES["/settings/writing"].done.never_say_skipped;
    expect(fillCounts(msg, { saved: "3", skipped: "2" })).toBe(
      "Saved 3. Skipped 2 (each needs 2 to 80 characters, up to 50 lines).",
    );
    // Anything that isn't a small number never reaches the screen.
    expect(fillCounts(msg, { saved: "<b>hi</b>", skipped: "2" })).toBe("Saved.");
    expect(fillCounts(msg, {})).toBe("Saved.");
    expect(fillCounts("Saved.", {})).toBe("Saved.");
  });

  it("the voice screen doesn't promise phrasesAvoided are never said (Check 15 P5)", () => {
    const src = readFileSync(join(SETTINGS, "writing", "page.tsx"), "utf8");
    expect(src).not.toContain("Drafts will never say");
    expect(src).toContain("Drafts try not to say");
  });

  it("Re-learn asks once before replacing the owner's edits", () => {
    const src = readFileSync(join(SETTINGS, "writing", "page.tsx"), "utf8");
    const at = src.indexOf("<form action={relearnVoiceAction}");
    expect(at).toBeGreaterThan(0);
    expect(src.lastIndexOf("<details", at)).toBeGreaterThan(src.lastIndexOf("</details>", at));
    expect(src).toContain("Yes, re-learn and replace my edits");
  });
});

describe("old Settings anchors", () => {
  it("every old section opens the screen that holds it now", () => {
    expect(LEGACY_SETTINGS_IDS).toHaveLength(12);
    for (const id of LEGACY_SETTINGS_IDS) {
      const to = legacySettingsScreen(`#${id}`);
      expect(to, id).toMatch(/^\/settings\/[a-z-]+$/);
      expect(existsSync(pageFor(to)), `${id} → ${to}`).toBe(true);
    }
    expect(legacySettingsScreen("#digest")).toBe("/settings/morning-email");
    expect(legacySettingsScreen("#texts")).toBe("/settings/texts");
    expect(legacySettingsScreen("")).toBe("/settings");
    expect(legacySettingsScreen("#//evil.example")).toBe("/settings");
  });

  it("emails link the morning email screen, not an anchor", () => {
    for (const f of ["src/server/digest.ts", "src/server/monthly-summary.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain('appUrl("/settings/morning-email")');
      expect(src, f).not.toContain("/settings#");
    }
  });
});

describe("five tabs", () => {
  it("marks the right tab current", () => {
    expect(currentTab("/queue")).toBe("/queue");
    expect(currentTab("/queue/review")).toBe("/queue");
    expect(currentTab("/money")).toBe("/money");
    expect(currentTab("/inbox")).toBe("/inbox");
    for (const p of [
      "/more",
      "/customers",
      "/customers/abc",
      "/activity",
      "/settings",
      "/settings/phone",
      "/billing",
      "/admin",
      "/record/x",
    ])
      expect(currentTab(p), p).toBe("/more");
    expect(currentTab("/moreover")).toBeNull();
    expect(currentTab("/welcome/terms")).toBeNull();
  });
});
