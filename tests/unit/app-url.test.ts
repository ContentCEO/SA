import { describe, expect, it } from "vitest";
import { appUrl } from "@/lib/app-url";

describe("appUrl", () => {
  it("prefers APP_URL and strips trailing slashes", () => {
    expect(
      appUrl("/x", { APP_URL: "https://sa.example/", VERCEL_BRANCH_URL: "b.vercel.app" }),
    ).toBe("https://sa.example/x");
  });

  it("falls back to the Vercel branch URL on previews", () => {
    expect(appUrl("/api/gmail/callback", { VERCEL_BRANCH_URL: "sa-git-x-dac3.vercel.app" })).toBe(
      "https://sa-git-x-dac3.vercel.app/api/gmail/callback",
    );
  });

  it("defaults to localhost", () => {
    expect(appUrl("", {})).toBe("http://localhost:3000");
  });
});
