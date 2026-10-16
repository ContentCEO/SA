import { describe, expect, it } from "vitest";
import { isPointerChange, POINTER_CHANGE_WINDOW_MS } from "@/components/forms/auto-save-rules";

describe("AutoSaveForm radios save only on a tap (outside review follow-up)", () => {
  it("saves a change right after a tap", () => {
    expect(isPointerChange(1_000, 1_050)).toBe(true);
  });
  it("waits for Save on a keyboard change (no pointer, or a stale one)", () => {
    expect(isPointerChange(0, 5_000)).toBe(false);
    expect(isPointerChange(1_000, 1_000 + POINTER_CHANGE_WINDOW_MS + 1)).toBe(false);
  });
});
