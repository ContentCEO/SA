import { expect, type Page, test } from "@playwright/test";
import { seedAdmin, seedOwner, seedQueue, setWorkspace, signInAs } from "./support";

/**
 * Check 8 P8: every target on the signed-in screens is at least 44×44 (a link inside running
 * text excepted), and no two targets in the same row or column are closer than 8px (gloves).
 * Rows of a divided list (More, Settings, the tab bar), 56px or taller, may touch.
 */
async function problems(page: Page) {
  return page.evaluate(() => {
    const sel =
      "a, button, select, textarea, summary, [role=button], input:not([type=hidden]):not([type=checkbox]):not([type=radio])";
    const out: string[] = [];
    const name = (el: Element) =>
      `${el.tagName.toLowerCase()} "${(el.getAttribute("aria-label") || el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40)}"`;
    const inText = (el: Element) => {
      if (el.tagName !== "A") return false;
      const parent = el.parentElement;
      if (!parent) return false;
      const own = (el.textContent ?? "").trim().length;
      const around = (parent.textContent ?? "").trim().length;
      return around > own + 10 && getComputedStyle(el).display === "inline";
    };
    // Checkboxes and radios: their <label> (min-h-tap) is the target.
    const labels = Array.from(document.querySelectorAll("label")).filter((l) =>
      l.querySelector("input[type=checkbox], input[type=radio]"),
    );
    const els = [...Array.from(document.querySelectorAll(sel)), ...labels].filter((el) => {
      const h = el as HTMLElement;
      const r = h.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      if (h.closest("[aria-hidden=true], [inert]")) return false;
      if (h.matches(".sr-only:not(:focus)")) return false;
      // Not rendered: display none, visibility hidden, or inside a closed <details>.
      return h.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    });
    const boxes = els.map((el) => ({ el, r: el.getBoundingClientRect() }));
    for (const { el, r } of boxes) {
      if (inText(el)) continue;
      if (r.height < 43.5 || r.width < 43.5)
        out.push(`${name(el)} is ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    for (let i = 0; i < boxes.length; i++)
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
        // The fixed tab bar sits over the page: the page under it scrolls up past it.
        if (!!a.el.closest("[data-tabbar]") !== !!b.el.closest("[data-tabbar]")) continue;
        if (inText(a.el) || inText(b.el)) continue;
        const rowOverlap = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        const colOverlap = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        let gap: number | null = null;
        if (rowOverlap > 0) gap = Math.max(b.r.left - a.r.right, a.r.left - b.r.right);
        else if (colOverlap > 0) gap = Math.max(b.r.top - a.r.bottom, a.r.top - b.r.bottom);
        if (gap === null || gap < -0.5 || gap >= 7.5) continue;
        const listRows = a.r.height >= 55.5 && b.r.height >= 55.5;
        if (listRows) continue;
        out.push(`${name(a.el)} and ${name(b.el)} are ${Math.round(gap)}px apart`);
      }
    return out;
  });
}

const OWNER_SCREENS = [
  "/queue",
  "/inbox",
  "/quotes",
  "/money",
  "/more",
  "/customers",
  "/activity",
  "/settings",
  "/settings/account",
  "/settings/autopilot",
  "/settings/away",
  "/settings/business",
  "/settings/follow-ups",
  "/settings/gmail",
  "/settings/morning-email",
  "/settings/phone",
  "/settings/sender-rules",
  "/settings/writing",
  "/billing",
];

async function sweep(page: Page, paths: string[]) {
  const found: string[] = [];
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 812 });
    for (const path of paths) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      for (const p of await problems(page)) found.push(`${width}px ${path}: ${p}`);
    }
  }
  return found;
}

test.describe("tap targets at 375px and 320px", () => {
  test.describe.configure({ timeout: 240_000 });
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== "mobile", "phone sizes");
  });

  test("the owner", async ({ page, context }) => {
    const owner = await seedOwner({ mailbox: true, backfilled: true });
    await setWorkspace(owner.workspaceId, { status: "active", plan: "crew" });
    await seedQueue(owner.mailboxId!);
    await signInAs(context, owner);
    expect(await sweep(page, OWNER_SCREENS)).toEqual([]);
  });

  test("a trial owner", async ({ page, context }) => {
    const trial = await seedOwner({ mailbox: true, backfilled: true });
    await setWorkspace(trial.workspaceId, {
      status: "evaluating",
      evaluationEndsAt: new Date(Date.now() + 2 * 86_400_000),
    });
    await seedQueue(trial.mailboxId!);
    await signInAs(context, trial);
    expect(await sweep(page, ["/queue", "/inbox", "/quotes", "/money", "/billing"])).toEqual([]);
  });

  test("the admin", async ({ page, context }) => {
    await signInAs(context, await seedAdmin());
    expect(
      await sweep(page, ["/admin", "/admin/costs", "/admin/growth", "/admin/video", "/more"]),
    ).toEqual([]);
  });
});
