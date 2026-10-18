import { describe, expect, it } from "vitest";
import { countdownWords } from "@/app/(app)/queue/autopilot-countdown";

/** Check 9 P2: the autopilot card counts down on its own: minutes, then seconds. */
describe("Check 9 P2: countdown words", () => {
  it("minutes, rounded up, while more than a minute is left", () => {
    expect(countdownWords(6 * 60_000)).toBe("Sends in 6 min");
    expect(countdownWords(5 * 60_000 + 1)).toBe("Sends in 6 min");
    expect(countdownWords(61_000)).toBe("Sends in 2 min");
    expect(countdownWords(60_000)).toBe("Sends in 1 min");
  });
  it("seconds in the last minute, then sending", () => {
    expect(countdownWords(59_000)).toBe("Sends in 59 seconds");
    expect(countdownWords(1_000)).toBe("Sends in 1 second");
    expect(countdownWords(0)).toBe("Sending now…");
    expect(countdownWords(-5_000)).toBe("Sending now…");
  });
});
