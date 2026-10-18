/**
 * Check 32 P5: one empty polite live region is always on the page (src/app/layout.tsx), so a
 * notice that arrives with a new render is read out: screen readers announce a change inside a
 * region that already exists, and often skip a status region that appears already filled.
 * Strong notices stay role="alert" on the notice itself: an alert is announced as it appears
 * (its own event, not a live-region change), and a second copy would be read twice.
 * No customer names or email text ever go through here: notices are fixed app sentences.
 */
export const ANNOUNCER_ID = "sa-announcer";

/** Clear first, then set the words this long after, so the same words twice are read twice. */
export const ANNOUNCE_DELAY_MS = 100;

type Region = { textContent: string | null };

/**
 * The live regions themselves, registered by Announcers once mounted. They live in closed
 * shadow roots: the notice's words are already on screen once, so a second copy in the page's
 * own text would match twice in find-in-page and in tests that look for the notice, while
 * screen readers still read shadow content.
 */
const regions = new Map<string, Region>();
export function registerRegion(id: string, region: Region | null) {
  if (region) regions.set(id, region);
  else regions.delete(id);
}
export function findRegion(id: string): Region | null {
  return regions.get(id) ?? null;
}

/**
 * Writes `text` into the announcer. Returns a cleanup:
 * cancels a pending write and, if the region still holds these words, empties it (so a screen
 * left behind doesn't leave its notice in the region).
 */
export function announce(
  find: (id: string) => Region | null,
  text: string,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  cancel: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
): () => void {
  const id = ANNOUNCER_ID;
  const words = text.replace(/\s+/g, " ").trim();
  if (!words) return () => {};
  const now = find(id);
  if (now) now.textContent = "";
  // Looked up again when it's time: on a first load the regions may mount just after the notice.
  let filled: Region | null = null;
  const handle = schedule(() => {
    const region = find(id);
    // Two writers of the same words in one render (the notice and the focus restore) say it once.
    if (region && region.textContent !== words) region.textContent = words;
    filled = region;
  }, ANNOUNCE_DELAY_MS);
  return () => {
    cancel(handle);
    if (filled && filled.textContent === words) filled.textContent = "";
  };
}
