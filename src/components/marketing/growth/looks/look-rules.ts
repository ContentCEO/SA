/**
 * TEMPORARY preview chooser for the homepage switch's look. Remove this file, looks/index.ts's
 * other entries and the `?look=` reading in growth-switch.tsx once a look is picked.
 *
 * `/?look=1` … `/?look=5` previews one of the five candidate looks; no param, or anything else,
 * is the current look, unchanged. Pure rules (no DOM, no React) so they are unit-tested on their
 * own (tests/unit/growth-looks.test.ts).
 */

/** The URL search param that picks a look (temporary, see above). */
export const LOOK_PARAM = "look";

/** The candidate looks a preview link can ask for. */
export const PREVIEW_LOOK_IDS = ["1", "2", "3", "4", "5"] as const;
export type PreviewLookId = (typeof PREVIEW_LOOK_IDS)[number];

/** "current" is the look the homepage has today; it is what everyone sees without `?look=`. */
export type LookId = "current" | PreviewLookId;
export const DEFAULT_LOOK: LookId = "current";

function isPreviewLookId(value: string): value is PreviewLookId {
  return (PREVIEW_LOOK_IDS as readonly string[]).includes(value);
}

/** The look a page's search string (`window.location.search`) asks for; the default otherwise. */
export function lookIdFrom(search: string): LookId {
  let value: string | null = null;
  try {
    value = new URLSearchParams(search).get(LOOK_PARAM);
  } catch {
    return DEFAULT_LOOK;
  }
  return value !== null && isPreviewLookId(value) ? value : DEFAULT_LOOK;
}
