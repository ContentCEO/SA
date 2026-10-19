"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { announce, findRegion } from "@/lib/announce";
import {
  rememberControl,
  rememberSubmitter,
  takeEntry,
  targetSelectors,
} from "@/lib/focus-after-save";

/** Screens whose forms redirect back to themselves with a notice (the settings screens). */
const SETTINGS = /^\/settings(\/|$)/;

function visible(el: Element): el is HTMLElement {
  return el instanceof HTMLElement && el.offsetParent !== null && !el.hasAttribute("disabled");
}

/**
 * Puts focus back after a settings save, if one just landed on this screen (takeEntry: same
 * path, a ?done= / ?error= notice, fresh). Runs where the URL changes (FocusAfterSave) and as
 * each Notice mounts: a second save on the same screen lands on the same address, so the URL
 * doesn't change, yet the screen is rendered anew and the focused switch is replaced (E2E
 * hardening, 2026-10-19: focus dropped to the page on every save after the first). Whichever
 * runs first takes the entry. Returns a cleanup for the retry timer.
 */
export function restoreFocusAfterSave(): () => void {
  const entry = takeEntry();
  if (!entry) return () => {};
  let tries = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const attempt = () => {
    const notice = document.querySelector<HTMLElement>("main [data-notice]");
    const target = targetSelectors(entry, CSS.escape)
      .map((sel) => Array.from(document.querySelectorAll(`main ${sel}`)).find(visible))
      .find(Boolean);
    // The screen may still be streaming in: look again for up to about a second.
    if (!target && !notice && tries++ < 10) {
      timer = setTimeout(attempt, 100);
      return;
    }
    if (target) target.focus();
    else if (notice) {
      notice.tabIndex = -1;
      notice.focus();
    }
    // A save that lands on the same words again is read again (strong notices are alerts,
    // announced as they appear).
    if (notice?.textContent && notice.dataset.notice !== "strong")
      announce(findRegion, notice.textContent);
  };
  attempt();
  return () => clearTimeout(timer);
}

/**
 * Check 32 P5: after a settings save lands back on its screen, put focus where the owner left
 * it (or on the notice) and read the notice out once more. Renders nothing.
 */
export function FocusAfterSave() {
  const pathname = usePathname();
  const search = useSearchParams()?.toString() ?? "";

  // Note the button behind every settings form submit (AutoSaveForm notes its own switches).
  useEffect(() => {
    const onSubmit = (e: SubmitEvent) => {
      if (!SETTINGS.test(location.pathname)) return;
      const btn = e.submitter;
      if (!btn) return; // requestSubmit() from AutoSaveForm, which noted its switch
      if (btn.hasAttribute("data-refocus") || btn.hasAttribute("name"))
        return rememberSubmitter(btn);
      // A Save under a set of switches: back to the chosen one.
      const form = e.target as HTMLFormElement;
      const radio = form.querySelector<HTMLInputElement>('input[type="radio"]:checked');
      const boxes = form.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
      if (radio) rememberControl(radio);
      else if (boxes.length === 1) rememberControl(boxes[0]!);
      else rememberSubmitter(btn);
    };
    document.addEventListener("submit", onSubmit, true);
    return () => document.removeEventListener("submit", onSubmit, true);
  }, []);

  // A save that lands on a new address (?done= after none, or a different notice).
  useEffect(() => restoreFocusAfterSave(), [pathname, search]);

  return null;
}
