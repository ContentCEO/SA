import { describe, expect, it } from "vitest";
import { FEATURE_ENV, featureOn } from "@/config/features";
import { outlookClientCredentials, outlookOffered } from "@/config/outlook";

/** Plan #49: Outlook is offered only with the switch on AND the Azure app's id and secret. */
describe("Outlook switch (FEATURE_OUTLOOK)", () => {
  const creds = { MS_CLIENT_ID: "id-1", MS_CLIENT_SECRET: "secret-1" };

  it("uses FEATURE_OUTLOOK with the usual on-words", () => {
    expect(FEATURE_ENV.outlook).toBe("FEATURE_OUTLOOK");
    for (const v of ["1", "true", "on", " ON "])
      expect(featureOn("outlook", { FEATURE_OUTLOOK: v })).toBe(true);
    for (const v of ["", "yes", "0", "off"])
      expect(featureOn("outlook", { FEATURE_OUTLOOK: v })).toBe(false);
  });

  it("is off by default and in tests", () => {
    expect(outlookOffered({})).toBe(false);
    expect(process.env.FEATURE_OUTLOOK ?? "").toBe("");
    expect(outlookOffered()).toBe(false);
    expect(outlookClientCredentials()).toBeNull();
  });

  it("needs the switch and both credentials", () => {
    expect(outlookOffered(creds)).toBe(false);
    expect(outlookOffered({ FEATURE_OUTLOOK: "1" })).toBe(false);
    expect(outlookOffered({ FEATURE_OUTLOOK: "1", MS_CLIENT_ID: "id-1" })).toBe(false);
    expect(outlookOffered({ FEATURE_OUTLOOK: "1", MS_CLIENT_SECRET: "s" })).toBe(false);
    expect(outlookOffered({ FEATURE_OUTLOOK: "1", MS_CLIENT_ID: " ", MS_CLIENT_SECRET: "s" })).toBe(
      false,
    );
    expect(outlookOffered({ FEATURE_OUTLOOK: "1", ...creds })).toBe(true);
    expect(outlookClientCredentials({ FEATURE_OUTLOOK: "1", ...creds })).toEqual({
      clientId: "id-1",
      clientSecret: "secret-1",
    });
  });
});
