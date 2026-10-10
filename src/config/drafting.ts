/**
 * Drafting settings (feature plan #8, #7, #3). Change here, not in components.
 */

/** Confidence (0–100) at or above which a clean draft is labelled "Ready". */
export const READY_AT = 80;
/** Below this, "Check everything". In between (or any flag/gap): "Check the details". */
export const CHECK_DETAILS_AT = 50;

export type ConfidenceLabel = "ready" | "check_details" | "check_everything";

export const confidenceWords: Record<ConfidenceLabel, string> = {
  ready: "Ready",
  check_details: "Check the details",
  check_everything: "Check everything",
};

/** Flags and unfilled gaps always mean at least "Check the details" — never "Ready". */
export function confidenceLabel(d: {
  confidencePct: number | null;
  flags: number;
  gaps: number;
}): ConfidenceLabel {
  const c = d.confidencePct ?? 0;
  if (c < CHECK_DETAILS_AT) return "check_everything";
  if (c < READY_AT || d.flags > 0 || d.gaps > 0) return "check_details";
  return "ready";
}

/** Undo window after tapping Send reply (plan #7): 10–30 seconds. */
export const UNDO_WINDOW_SECONDS = 20;

/** Quick tweaks / voice edits allowed per draft (plan #3). */
export const MAX_REVISIONS_PER_DRAFT = 5;
