/**
 * Rule numbers the product promises (homepage, settings) and the server enforces. Pure, so a
 * public page can quote them without importing server code; the server modules re-export them.
 */

/** Autopilot: replies in a category sent exactly as drafted before it can be switched on. */
export const EARN_THRESHOLD = 10;
/** Autopilot: minutes a reply waits in the queue (with "Hold it") before it goes. */
export const GRACE_MINUTES = 10;
/** Follow-up nudges sent per conversation, ever. A guardrail, not a setting. */
export const MAX_FOLLOWUPS = 2;
