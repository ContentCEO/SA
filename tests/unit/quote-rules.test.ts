import { describe, expect, it } from "vitest";
import { isServiceCall, SERVICE_CALL_LABEL, stageLabel } from "@/server/quote-rules";

describe("service calls (Check 36 P3)", () => {
  const emergency = { emergency: true, emergency_at: "2026-10-01T12:00:00Z" };
  it("an emergency answered with no price is a service call", () => {
    expect(isServiceCall(emergency, "On my way, be there in 30.")).toBe(true);
    expect(isServiceCall(emergency, null)).toBe(true);
  });
  it("a price brings normal chasing back; a normal quote is never one", () => {
    expect(isServiceCall(emergency, "It'll be $380 to replace the section.")).toBe(false);
    expect(isServiceCall({}, "On my way.")).toBe(false);
    expect(isServiceCall(null, "On my way.")).toBe(false);
  });
  it("is a display label, not a stored stage", () => {
    expect(SERVICE_CALL_LABEL).toBe("Service call");
    expect(Object.values(stageLabel)).not.toContain(SERVICE_CALL_LABEL);
  });
});
