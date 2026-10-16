/**
 * Pure rule for AutoSaveForm: did this radio change come from a tap or click (save at once), or
 * from the keyboard (arrow keys step through the group, so wait for the Save button)?
 * Keyboard changes fire no pointerdown, so a change within this window of one is a pointer's.
 */
export const POINTER_CHANGE_WINDOW_MS = 1500;

export function isPointerChange(lastPointerDownAt: number, now: number): boolean {
  return lastPointerDownAt > 0 && now - lastPointerDownAt <= POINTER_CHANGE_WINDOW_MS;
}
