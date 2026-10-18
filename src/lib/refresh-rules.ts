/**
 * Check 8 P3: when the installed app comes back to the front, the list may be old (an iPhone
 * home-screen app has no reload button and no pull-to-refresh). Pure rules, used by
 * RefreshOnReturn (src/components/app/refresh-on-return.tsx).
 */

/** Hidden for at least this long → refresh the screen on return. */
export const REFRESH_AFTER_HIDDEN_MS = 60_000;

/** What the screen is doing right now, read from the page by the component. */
export type ReturnState = {
  /** When the page went to the background (ms), or null if it hasn't since the last refresh. */
  hiddenAt: number | null;
  now: number;
  /** A textarea or text box has focus. */
  typing: boolean;
  /** Something on screen is open for editing (`[data-editing="true"]`, e.g. a draft's Edit). */
  editing: boolean;
};

/**
 * "refresh" now; "later" once the owner stops typing / editing (a refresh must never wipe an
 * open edit); "no" when the app wasn't away long enough (or wasn't away at all).
 */
export function returnDecision(s: ReturnState): "refresh" | "later" | "no" {
  if (s.hiddenAt === null || s.now - s.hiddenAt < REFRESH_AFTER_HIDDEN_MS) return "no";
  return s.typing || s.editing ? "later" : "refresh";
}

/** Input types that take typing (a checkbox or button with focus doesn't block a refresh). */
const TEXT_INPUTS = new Set([
  "text",
  "search",
  "email",
  "tel",
  "url",
  "number",
  "password",
  "date",
  "time",
  "datetime-local",
  "month",
  "week",
]);

/** Whether an element with focus (tag + type, or contenteditable) takes typing. */
export function takesTyping(el: {
  tagName: string;
  type?: string;
  isContentEditable?: boolean;
}): boolean {
  if (el.isContentEditable) return true;
  const tag = el.tagName.toUpperCase();
  if (tag === "TEXTAREA") return true;
  if (tag !== "INPUT") return false;
  return TEXT_INPUTS.has((el.type || "text").toLowerCase());
}

/** "9:41 AM" in the owner's time zone, for the "Updated …" line (rendered by the server). */
export function updatedTime(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(
    now,
  );
}
