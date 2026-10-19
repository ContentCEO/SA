import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "@/db";
import { activityLog, businessProfiles } from "@/db/schema";
import { ensureUserAndWorkspace } from "@/server/accounts";
import {
  businessProfileInput,
  digestSettingsInput,
  saveBusinessProfile,
  saveDetectedTimeZone,
  saveDigestSettings,
  setOwnerTimeZone,
} from "@/server/profile";
import {
  isTimeZone,
  nowLine,
  sameClock,
  US_TIME_ZONES,
  pickedTimeZone,
  zoneChoices,
  zoneLine,
  zoneShortName,
  zoneTimeName,
} from "@/server/time-zone-rules";
import { createTestDb } from "../support/db";

/**
 * Check 45 P1 + Check 44 P5 + Check 15 P7: the owner's time zone is saved from the browser once
 * (while never set), shown on Settings → Morning email, and changed only by a deliberate pick.
 */
const session = vi.hoisted(() => ({ ws: null as string | null }));
class Redirected extends Error {
  constructor(readonly url: string) {
    super("redirect");
  }
}
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirected(url);
  },
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/server/session", () => ({
  requireOwner: async () => {
    if (!session.ws) throw new Redirected("/signin");
    return { workspace: { id: session.ws } };
  },
}));

const { saveDetectedTimeZoneAction, takePhoneZoneAction, saveDigestSettingsAction } =
  await import("@/app/(app)/settings/profile-actions");

const form = (f: Record<string, string>) => {
  const d = new FormData();
  for (const [k, v] of Object.entries(f)) d.set(k, v);
  return d;
};
const whereTo = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (err) {
    if (err instanceof Redirected) return err.url;
    throw err;
  }
  return null;
};

describe("time zone words (pure)", () => {
  it("names the US zones in plain words, and falls back to the zone's own name", () => {
    expect(zoneShortName("America/New_York")).toBe("Eastern");
    expect(zoneShortName("America/Detroit")).toBe("Eastern");
    expect(zoneShortName("America/Los_Angeles")).toBe("Pacific");
    expect(zoneShortName("Europe/London")).toBe("Europe/London");
    expect(zoneShortName("Not/AZone")).toBe("Eastern");
    expect(zoneShortName(null)).toBe("Eastern");
    expect(zoneTimeName("America/Chicago")).toBe("Central time");
    expect(zoneLine("America/New_York")).toBe("Times are in Eastern time (New York, Boston).");
    expect(zoneLine("Europe/London")).toBe("Times are in Europe/London time.");
  });

  it("says the time there now", () => {
    const at = new Date("2026-10-19T11:42:00Z"); // 7:42 am in New York (EDT)
    expect(nowLine(at, "America/New_York")).toBe("It's 7:42 am there now.");
    expect(nowLine(at, "America/Los_Angeles")).toBe("It's 4:42 am there now.");
    expect(nowLine(new Date("2026-10-19T19:05:00Z"), "America/Chicago")).toBe(
      "It's 2:05 pm there now.",
    );
  });

  it("lists the US zones, plus the saved one when it isn't on the list", () => {
    expect(zoneChoices("America/Chicago").map((c) => c.value)).toEqual(
      US_TIME_ZONES.map((z) => z.value),
    );
    expect(zoneChoices("Europe/London").at(-1)).toEqual({
      value: "Europe/London",
      label: "Europe/London",
    });
    expect(sameClock("US/Eastern", "America/New_York")).toBe(true);
    expect(sameClock("America/Chicago", "America/New_York")).toBe(false);
    expect(isTimeZone("America/Chicago")).toBe(true);
    expect(isTimeZone("Mars/Base")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("digestSettingsInput (Check 15 P7)", () => {
  it("takes every listed zone, refuses a made-up one, and leaves a missing one out", () => {
    for (const z of US_TIME_ZONES) {
      expect(digestSettingsInput.parse({ hour: "7", timeZone: z.value }).timeZone).toBe(z.value);
    }
    expect(digestSettingsInput.safeParse({ hour: "7", timeZone: "Mars/Base" }).success).toBe(false);
    expect(digestSettingsInput.parse({ hour: "7" }).timeZone).toBeUndefined();
  });
});

describe("saving the zone", () => {
  let database: Database;
  let ws: string;
  const profile = async () =>
    (await database.select().from(businessProfiles).where(eq(businessProfiles.workspaceId, ws)))[0];
  const logged = async (action: string) =>
    (await database.select().from(activityLog).where(eq(activityLog.workspaceId, ws))).filter(
      (r) => r.action === action,
    );

  beforeEach(async () => {
    database = await createTestDb();
    const { workspace } = await ensureUserAndWorkspace({ email: "owner@shop.com" });
    ws = workspace.id;
    session.ws = ws;
  });

  it("a Morning email save no longer changes the zone by itself (Check 44 P5)", async () => {
    await saveDetectedTimeZone(ws, "America/Chicago");
    await saveDigestSettings(ws, digestSettingsInput.parse({ enabled: "on", hour: "6" }));
    expect(await profile()).toMatchObject({ timeZone: "America/Chicago", digestHour: 6 });
    // The action without the select keeps the stored zone too.
    expect(await whereTo(() => saveDigestSettingsAction(form({ hour: "8" })))).toBe(
      "/settings/morning-email?done=saved",
    );
    expect(await profile()).toMatchObject({ timeZone: "America/Chicago", digestHour: 8 });
    expect(await logged("time_zone_changed")).toHaveLength(0);
  });

  it("the select changes it as the owner's pick, logging the zone names only", async () => {
    await whereTo(() =>
      saveDigestSettingsAction(form({ hour: "7", timeZone: "America/Los_Angeles" })),
    );
    expect(await profile()).toMatchObject({
      timeZone: "America/Los_Angeles",
      timeZoneSource: "owner",
    });
    const [row] = await logged("time_zone_changed");
    expect(row!.detail).toEqual({ from: "America/New_York", to: "America/Los_Angeles" });
    // Same zone again: nothing new logged.
    await whereTo(() =>
      saveDigestSettingsAction(form({ hour: "7", timeZone: "America/Los_Angeles" })),
    );
    expect(await logged("time_zone_changed")).toHaveLength(1);
    expect(await setOwnerTimeZone(ws, "Mars/Base")).toBe(false);
  });

  it("“Use Central time” saves through the action, re-checking the owner and the zone", async () => {
    await saveDetectedTimeZone(ws, "America/New_York");
    expect(await whereTo(() => takePhoneZoneAction(form({ timeZone: "Mars/Base" })))).toBe(
      "/settings/morning-email?error=zone",
    );
    expect((await profile())!.timeZone).toBe("America/New_York");
    expect(await whereTo(() => takePhoneZoneAction(form({ timeZone: "America/Chicago" })))).toBe(
      "/settings/morning-email?done=zone",
    );
    expect(await profile()).toMatchObject({
      timeZone: "America/Chicago",
      timeZoneSource: "owner",
    });
    const [row] = await logged("time_zone_changed");
    expect(row!.detail).toEqual({ from: "America/New_York", to: "America/Chicago" });

    session.ws = null;
    expect(await whereTo(() => takePhoneZoneAction(form({ timeZone: "Pacific/Honolulu" })))).toBe(
      "/signin",
    );
    expect((await profile())!.timeZone).toBe("America/Chicago");
  });

  describe("the browser's zone on the first page load (Check 45 P1)", () => {
    it("sets zone and source while it was never set (no row yet, or 'default')", async () => {
      await saveDetectedTimeZoneAction("America/Los_Angeles");
      expect(await profile()).toMatchObject({
        timeZone: "America/Los_Angeles",
        timeZoneSource: "browser",
      });
      expect(await logged("time_zone_detected")).toHaveLength(1);
      expect((await logged("time_zone_detected"))[0]!.detail).toEqual({});

      const other = await ensureUserAndWorkspace({ email: "two@shop.com" });
      await database.insert(businessProfiles).values({ workspaceId: other.workspace.id });
      session.ws = other.workspace.id;
      await saveDetectedTimeZoneAction("America/Denver");
      const [p] = await database
        .select()
        .from(businessProfiles)
        .where(eq(businessProfiles.workspaceId, other.workspace.id));
      expect(p).toMatchObject({ timeZone: "America/Denver", timeZoneSource: "browser" });
    });

    it("ignores an invalid zone", async () => {
      await saveDetectedTimeZoneAction("Mars/Base");
      await saveDetectedTimeZoneAction(42);
      expect(await profile()).toBeUndefined();
      expect(await logged("time_zone_detected")).toHaveLength(0);
    });

    it("does nothing once the source is 'browser' or 'owner'", async () => {
      await saveDetectedTimeZoneAction("America/Los_Angeles");
      await saveDetectedTimeZoneAction("America/Chicago");
      expect((await profile())!.timeZone).toBe("America/Los_Angeles");
      await setOwnerTimeZone(ws, "America/Denver");
      await saveDetectedTimeZoneAction("America/Chicago");
      expect(await profile()).toMatchObject({
        timeZone: "America/Denver",
        timeZoneSource: "owner",
      });
      expect(await logged("time_zone_detected")).toHaveLength(1);
    });

    it("requires an owner", async () => {
      session.ws = null;
      expect(await whereTo(() => saveDetectedTimeZoneAction("America/Chicago"))).toBe("/signin");
    });
  });

  describe("business profile saves", () => {
    const valid = {
      businessName: "Elm Electric",
      trade: "electrical",
      services: "Service calls",
      serviceArea: "",
      hours: "",
      leadTime: "",
      pricingNotes: "",
      paymentTerms: "",
      policies: "",
      signature: "",
      doNotPromise: "",
      vipSenders: "",
      amountThresholdDollars: "2500",
    };

    it("a row made by the first page load still gets marked done by the setup save", async () => {
      await saveDetectedTimeZoneAction("America/Los_Angeles");
      expect((await profile())!.completedAt).toBeNull();
      const at = new Date("2026-10-18T12:00:00Z");
      await saveBusinessProfile(ws, businessProfileInput.parse(valid), at);
      expect((await profile())!.completedAt).toEqual(at);
      // A later save keeps the first date.
      await saveBusinessProfile(
        ws,
        businessProfileInput.parse(valid),
        new Date("2026-11-01T12:00:00Z"),
      );
      expect((await profile())!.completedAt).toEqual(at);
      expect((await profile())!.timeZone).toBe("America/Los_Angeles");
    });

    it("a /settings/profile save never changes the zone", async () => {
      await saveDetectedTimeZone(ws, "America/Chicago");
      await saveBusinessProfile(ws, businessProfileInput.parse(valid));
      expect((await profile())!.timeZone).toBe("America/Chicago");
    });

    it("setup's browser zone is saved as 'browser', but never over the owner's pick", async () => {
      await saveBusinessProfile(
        ws,
        businessProfileInput.parse({ ...valid, timeZone: "America/Phoenix" }),
      );
      expect(await profile()).toMatchObject({
        timeZone: "America/Phoenix",
        timeZoneSource: "browser",
      });
      await setOwnerTimeZone(ws, "America/Denver");
      await saveBusinessProfile(
        ws,
        businessProfileInput.parse({ ...valid, timeZone: "America/Los_Angeles" }),
      );
      expect(await profile()).toMatchObject({
        timeZone: "America/Denver",
        timeZoneSource: "owner",
      });
    });
  });
});

describe("pickedTimeZone (integrator 2026-10-19: an untouched select is not the owner's pick)", () => {
  it("saves only a zone the owner changed from the one shown", () => {
    expect(pickedTimeZone("America/New_York", "America/New_York")).toBeNull();
    expect(pickedTimeZone("America/Chicago", "America/New_York")).toBe("America/Chicago");
  });
  it("nothing posted: nothing picked", () => {
    expect(pickedTimeZone(undefined, "America/New_York")).toBeNull();
    expect(pickedTimeZone("", "America/New_York")).toBeNull();
  });
  it("a form from before the shown field counts the posted zone as picked (old behaviour)", () => {
    expect(pickedTimeZone("America/New_York", null)).toBe("America/New_York");
  });
});
