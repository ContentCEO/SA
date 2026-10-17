/**
 * Check 43 P9: fixed words (code, not the model's) for a reply on a thread about a dispute or
 * something legal (`extracted.disputed`, or the needs-owner reason LEGAL_REASON /
 * DISPUTE_REASON). Only the owner's own "Draft a reply" ever drafts one; the written reply can
 * become the record, so it stays short and factual. Recorded on the draft as
 * `draft.vN+dispute-caution.v1`.
 */
export const DISPUTE_CAUTION_PROMPT_VERSION = "dispute-caution.v1";

/** Added to the conversation's task for those threads. */
export const DISPUTE_TASK =
  "Keep this reply short and factual. Acknowledge their email, say when the owner will call or reply in full, and do not explain causes, admit fault, agree to refunds, or promise dates or work.";

/** The fixed flag, always first on the card. */
export const DISPUTE_FLAG =
  "This is about a dispute or something legal. What you write can be used later. Keep it short and factual; many owners call their lawyer or insurer first.";

/** The card never reads Ready on one of these. */
export const DISPUTE_CONFIDENCE_CAP = 0.4;
