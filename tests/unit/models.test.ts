import { describe, expect, it } from "vitest";
import { models } from "@/config/models";

describe("model config", () => {
  it("uses Haiku for classification and Sonnet for drafting", () => {
    expect(models.classify).toMatch(/^claude-haiku-4-5/);
    expect(models.draft).toBe("claude-sonnet-5");
    expect(models.voice).toBe("claude-sonnet-5");
  });
});
