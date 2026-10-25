/**
 * Check 26 P4: Delete my account's two server-side checks, as pure rules. The screen's
 * confirmation is only a convenience; these are the gate.
 */

/** The word the owner types to confirm. */
export const DELETE_CONFIRM_WORD = "DELETE";

/** How recent the Google sign-in must be to delete the account. */
export const DELETE_RECENT_SIGN_IN_MINUTES = 15;

/** The typed word, trimmed, in any case. Anything else (or nothing) is a no. */
export function deleteConfirmed(raw: unknown): boolean {
  return typeof raw === "string" && raw.trim().toUpperCase() === DELETE_CONFIRM_WORD;
}
