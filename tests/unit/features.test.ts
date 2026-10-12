import { describe, expect, it } from "vitest";
import { FEATURE_ENV, featureOn } from "@/config/features";

describe("feature switches", () => {
  it("are off by default", () => {
    expect(featureOn("closingQuestion", {})).toBe(false);
    expect(featureOn("closingQuestion", { FEATURE_CLOSING_QUESTION: "" })).toBe(false);
  });

  it.each(["1", "true", "on", "ON", "True", " on "])("turn on for %j", (value) => {
    expect(featureOn("closingQuestion", { FEATURE_CLOSING_QUESTION: value })).toBe(true);
  });

  it.each(["off", "0", "yes", "false", "enabled", "2"])("stay off for %j", (value) => {
    expect(featureOn("closingQuestion", { FEATURE_CLOSING_QUESTION: value })).toBe(false);
  });

  it("read only their own variable", () => {
    expect(FEATURE_ENV.closingQuestion).toBe("FEATURE_CLOSING_QUESTION");
    expect(featureOn("closingQuestion", { FEATURE_SOMETHING_ELSE: "1" })).toBe(false);
  });

  it("reads process.env when no env is passed (off in tests)", () => {
    expect(process.env.FEATURE_CLOSING_QUESTION ?? "").toBe("");
    expect(featureOn("closingQuestion")).toBe(false);
  });
});
