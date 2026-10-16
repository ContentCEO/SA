import { describe, expect, it } from "vitest";
import { BUSINESS_HOURS, LEAD_AT_RISK_HOURS } from "@/config/business-hours";
import { businessMinutesBetween, inBusinessHours } from "@/server/business-hours-rules";

const at = (s: string) => new Date(s);
const NY = "America/New_York";
const LA = "America/Los_Angeles";
// October 2026 in New York is EDT (UTC−4): 9am local = 13:00Z.
// Tue Oct 6, Wed Oct 7, Fri Oct 9, Sat Oct 10, Sun Oct 11, Mon Oct 12.

describe("the default business hours", () => {
  it("are Monday to Saturday, 7am to 6pm, and a lead is at risk after 4 of them", () => {
    expect(BUSINESS_HOURS).toEqual({ days: [1, 2, 3, 4, 5, 6], startHour: 7, endHour: 18 });
    expect(LEAD_AT_RISK_HOURS).toBe(4);
  });
});

describe("businessMinutesBetween", () => {
  it("same day, 9am → 11am", () => {
    expect(businessMinutesBetween(at("2026-10-06T13:00:00Z"), at("2026-10-06T15:00:00Z"), NY)).toBe(
      120,
    );
  });

  it("overnight: Tuesday 5pm → Wednesday 8am is 60 + 60", () => {
    expect(businessMinutesBetween(at("2026-10-06T21:00:00Z"), at("2026-10-07T12:00:00Z"), NY)).toBe(
      120,
    );
  });

  it("weekend: Saturday 5pm → Monday 8am is 60 (Sat) + 0 (Sun) + 60 (Mon)", () => {
    expect(businessMinutesBetween(at("2026-10-10T21:00:00Z"), at("2026-10-12T12:00:00Z"), NY)).toBe(
      120,
    );
  });

  it("Friday 5pm → Monday 9am is 60 + 660 + 0 + 120, first at risk Saturday 10am", () => {
    const friday5pm = at("2026-10-09T21:00:00Z");
    expect(businessMinutesBetween(friday5pm, at("2026-10-12T13:00:00Z"), NY)).toBe(840);
    expect(businessMinutesBetween(friday5pm, at("2026-10-10T14:00:00Z"), NY)).toBe(
      LEAD_AT_RISK_HOURS * 60,
    );
    expect(businessMinutesBetween(friday5pm, at("2026-10-10T13:59:00Z"), NY)).toBe(239);
  });

  it("Saturday 5pm → Monday 9am is 60 + 0 + 120: not at risk yet", () => {
    expect(businessMinutesBetween(at("2026-10-10T21:00:00Z"), at("2026-10-12T13:00:00Z"), NY)).toBe(
      180,
    );
  });

  it("an email before opening counts from 7am", () => {
    expect(businessMinutesBetween(at("2026-10-06T09:00:00Z"), at("2026-10-06T13:00:00Z"), NY)).toBe(
      120,
    );
  });

  it("is 0 when the end isn't after the start", () => {
    const t = at("2026-10-06T15:00:00Z");
    expect(businessMinutesBetween(t, t, NY)).toBe(0);
    expect(businessMinutesBetween(t, at("2026-10-06T13:00:00Z"), NY)).toBe(0);
  });

  it("DST days are 25 and 23 hours long", () => {
    const sundays = { days: [7], startHour: 0, endHour: 24 };
    // Nov 1, 2026: clocks go back. Counted across the whole weekend, only Sunday is open.
    expect(
      businessMinutesBetween(at("2026-10-31T12:00:00Z"), at("2026-11-02T12:00:00Z"), NY, sundays),
    ).toBe(1500);
    expect(
      businessMinutesBetween(at("2026-11-01T04:00:00Z"), at("2026-11-02T05:00:00Z"), NY, sundays),
    ).toBe(1500);
    // Mar 8, 2026: clocks go forward.
    expect(
      businessMinutesBetween(at("2026-03-07T12:00:00Z"), at("2026-03-09T12:00:00Z"), NY, sundays),
    ).toBe(1380);
  });

  it("uses the owner's zone: the same instants differ between New York and Los Angeles", () => {
    const from = at("2026-10-06T13:00:00Z"); // 9am NY, 6am LA
    const to = at("2026-10-06T15:00:00Z"); // 11am NY, 8am LA
    expect(businessMinutesBetween(from, to, NY)).toBe(120);
    expect(businessMinutesBetween(from, to, LA)).toBe(60);
  });

  it("an invalid zone counts in Eastern time", () => {
    const from = at("2026-10-06T13:00:00Z");
    const to = at("2026-10-06T15:00:00Z");
    expect(businessMinutesBetween(from, to, "Not/AZone")).toBe(120);
  });
});

describe("inBusinessHours (owner's zone)", () => {
  it.each([
    ["Mon 6:59am", "2026-10-12T10:59:00Z", false],
    ["Mon 7:00am", "2026-10-12T11:00:00Z", true],
    ["Mon 5:59pm", "2026-10-12T21:59:00Z", true],
    ["Mon 6:00pm", "2026-10-12T22:00:00Z", false],
    ["Sat noon", "2026-10-10T16:00:00Z", true],
    ["Sun noon", "2026-10-11T16:00:00Z", false],
  ])("%s New York → %s", (_label, when, open) => {
    expect(inBusinessHours(at(when), NY)).toBe(open);
  });

  it("Mon 7am in New York is 4am in Los Angeles", () => {
    expect(inBusinessHours(at("2026-10-12T11:00:00Z"), LA)).toBe(false);
  });
});
