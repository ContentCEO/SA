import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SCREEN_MESSAGES } from "@/app/(app)/settings/messages";
import { LEAD_AT_RISK_HOURS, LEAD_AT_RISK_PUSHES_PER_DAY } from "@/config/business-hours";
import { SMS } from "@/server/sms-alerts";
import { hourWord } from "@/server/sms-delivery-rules";
import { extraTextsCopy } from "@/server/sms-summary-rules";

/**
 * Plan #50: the Text alerts screen's two extra switches promise only what the code keeps. Every
 * number on the screen comes from the limits in code, never typed into the page.
 */

const PAGE = "src/app/(app)/settings/texts/page.tsx";
const limits = {
  ...SMS,
  atRiskHours: LEAD_AT_RISK_HOURS,
  atRiskPerDay: LEAD_AT_RISK_PUSHES_PER_DAY,
  digestHour: 7,
};

describe("#50 Text alerts screen: the morning summary and waiting-quote switches", () => {
  it("the words carry the code's numbers, the carrier line and plain promises", () => {
    const c = extraTextsCopy(limits);
    for (const x of [c.summary, c.atRisk]) {
      expect(x.cap).toContain(`${SMS.dailyCap} texts a day`);
      expect(x.cap).toContain(
        `never between ${hourWord(SMS.quietStartHour)} and ${hourWord(SMS.quietEndHour)}`,
      );
      expect(x.cap).toContain("Msg & data rates may apply.");
      expect(x.what).not.toMatch(/\bsubmit\b/i);
      expect(x.on).toMatch(/^Turn on /);
      expect(x.off).toMatch(/^Turn off /);
    }
    expect(c.summary.what).toContain("One text a day around 7am");
    expect(c.summary.what).toContain("Counts only, never a customer's name or words.");
    expect(c.summary.what).toContain("whether the morning email is on or off");
    expect(c.atRisk.what).toContain(`over ${LEAD_AT_RISK_HOURS} work hours`);
    expect(c.atRisk.what).toContain(`At most ${LEAD_AT_RISK_PUSHES_PER_DAY} a day`);
    expect(c.atRisk.what).toContain("once per wait");
  });

  it("follows the limits when they change (nothing is typed)", () => {
    const c = extraTextsCopy({
      ...limits,
      dailyCap: 4,
      quietStartHour: 20,
      quietEndHour: 8,
      atRiskHours: 6,
      atRiskPerDay: 2,
      digestHour: 9,
    });
    expect(c.summary.cap).toContain("4 texts a day, never between 8pm and 8am");
    expect(c.summary.what).toContain("around 9am");
    expect(c.atRisk.what).toContain("over 6 work hours");
    expect(c.atRisk.what).toContain("At most 2 a day");
  });

  it("the page builds them from SMS, the at-risk limits and the owner's hour, with no number typed", () => {
    const src = readFileSync(PAGE, "utf8");
    expect(src).toContain("extraTextsCopy({");
    expect(src).toContain("...SMS,");
    expect(src).toContain("atRiskHours: LEAD_AT_RISK_HOURS,");
    expect(src).toContain("atRiskPerDay: LEAD_AT_RISK_PUSHES_PER_DAY,");
    expect(src).toContain("digestHour: profile?.digestHour ?? 7,");
    // The switches show only while text alerts are on (the one switch STOP turns off).
    expect(src).toContain("{profile.smsAlertsEnabled\n            ? extras.map(");
    // No count, hour or cap typed into the switches' own words.
    const block = src.slice(src.indexOf("extras.map("), src.indexOf("removeSmsPhoneAction}>"));
    expect(block.length).toBeGreaterThan(100);
    const jsxText = [...block.matchAll(/>([^<>{}]+)</g)].map((m) => m[1]!.trim()).filter(Boolean);
    for (const t of jsxText) expect(t, t).not.toMatch(/\d/);
  });

  it("each switch's outcome has a notice", () => {
    const src = readFileSync("src/app/(app)/settings/sms-actions.ts", "utf8");
    expect(src).toContain('`sms_${which}_${enabled ? "on" : "off"}`');
    for (const k of ["sms_summary_on", "sms_summary_off", "sms_at_risk_on", "sms_at_risk_off"])
      expect(SCREEN_MESSAGES["/settings/texts"].done).toHaveProperty(k);
    expect(SCREEN_MESSAGES["/settings/texts"].error).toHaveProperty("sms_alerts_off");
  });
});
