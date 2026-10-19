/**
 * Check 32 P5: a save that redirects back to the same screen (?done= / ?error=) re-renders the
 * page, and focus dropped to the top. Just before the form goes, we note which control (or
 * button) the owner used in sessionStorage; once the screen is back, focus goes there again, or
 * to the notice when that control is gone.
 *
 * Only settings: control names and values (`enabled`, `hand=left`, `days`) or a fixed
 * `data-refocus` key. Never customer names or email text.
 */
export const FOCUS_KEY = "sa_focus_after_save";
/** An entry older than this belongs to some other save. */
export const FOCUS_ENTRY_MAX_AGE_MS = 15_000;

export type FocusEntry = {
  path: string;
  at: number;
  name?: string;
  value?: string;
  refocus?: string;
};

/** Is this entry for the screen that just rendered, with a save's notice in the URL? */
export function entryApplies(
  entry: FocusEntry | null,
  where: { path: string; search: string; now: number },
): boolean {
  if (!entry) return false;
  if (entry.path !== where.path) return false;
  if (where.now - entry.at > FOCUS_ENTRY_MAX_AGE_MS || where.now < entry.at) return false;
  const params = new URLSearchParams(where.search);
  return params.has("done") || params.has("error");
}

/** Parses a stored entry; anything odd reads as none. */
export function parseEntry(raw: string | null): FocusEntry | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as FocusEntry;
    if (typeof e?.path !== "string" || typeof e.at !== "number") return null;
    return e;
  } catch {
    return null;
  }
}

/** CSS for the element to focus: by data-refocus key, else by name (and value when given). */
export function targetSelectors(e: FocusEntry, escape: (s: string) => string): string[] {
  if (e.refocus) return [`[data-refocus="${escape(e.refocus)}"]`];
  if (!e.name) return [];
  const byName = `[name="${escape(e.name)}"]`;
  return e.value === undefined ? [byName] : [`${byName}[value="${escape(e.value)}"]`, byName];
}

function store(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/** Notes the control a self-saving form is about to submit (AutoSaveForm). */
export function rememberControl(el: { name?: string; value?: string; type?: string }) {
  if (!el.name) return;
  // A checkbox's value is the same on and off: the name finds it.
  const value = el.type === "checkbox" ? undefined : el.value;
  write({ path: location.pathname, at: Date.now(), name: el.name, value });
}

/** Notes the button that submitted a form: its data-refocus key, else its name and value. */
export function rememberSubmitter(btn: HTMLElement | null) {
  if (!btn) return;
  const refocus = btn.getAttribute("data-refocus") ?? undefined;
  const name = btn.getAttribute("name") ?? undefined;
  if (refocus) return write({ path: location.pathname, at: Date.now(), refocus });
  if (name)
    return write({
      path: location.pathname,
      at: Date.now(),
      name,
      value: btn.getAttribute("value") ?? undefined,
    });
  // Nothing to find it by: the notice gets focus.
  write({ path: location.pathname, at: Date.now() });
}

function write(e: FocusEntry) {
  try {
    store()?.setItem(FOCUS_KEY, JSON.stringify(e));
  } catch {
    // Private mode or full storage: focus just isn't restored.
  }
}

/** Reads and removes the entry if it belongs to this render. */
export function takeEntry(): FocusEntry | null {
  const s = store();
  let entry: FocusEntry | null = null;
  try {
    entry = parseEntry(s?.getItem(FOCUS_KEY) ?? null);
  } catch {
    return null;
  }
  const where = { path: location.pathname, search: location.search, now: Date.now() };
  if (!entryApplies(entry, where)) {
    // A stale one never lingers into a later save.
    if (entry && Date.now() - entry.at > FOCUS_ENTRY_MAX_AGE_MS) {
      try {
        s?.removeItem(FOCUS_KEY);
      } catch {}
    }
    return null;
  }
  try {
    s?.removeItem(FOCUS_KEY);
  } catch {}
  return entry;
}
