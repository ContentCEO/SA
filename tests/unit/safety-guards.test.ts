/**
 * Wave 1 "Safety guards": the code checks that don't trust the model, as pure functions.
 * Every email here is invented.
 */
import { describe, expect, it } from "vitest";
import { applyOwnerRules } from "@/ai/classify";
import {
  CO_REASON,
  GAS_SMELL_REASON,
  mentionsCarbonMonoxide,
  mentionsGasSmell,
  mentionsWaterSmell,
  WATER_SMELL_REASON,
} from "@/ai/guards";
import { guardrailReasons } from "@/server/autopilot";
import { classification } from "../support/fake-model";

/** A reply autopilot would send, so each test changes one thing. */
const OK = {
  category: "scheduling",
  needsOwner: false,
  kind: "reply" as const,
  confidencePct: 95,
  flags: [],
  amountsInEmail: [],
  draftBody: "Thursday works.",
  knownCustomer: true,
  purpose: null,
};

const rules = (
  ctx: Partial<Parameters<typeof applyOwnerRules>[1]> = {},
  m = classification({ category: "customer_question" }),
) =>
  applyOwnerRules(m, {
    firstTimeSender: false,
    senderIsVip: false,
    amountThresholdDollars: 2500,
    ...ctx,
  });

describe("gas check (Check 22 P4 + Check 36 P1)", () => {
  it.each([
    // Utility footers and newsletters (Check 22 P4).
    "Your bill is ready. Amount due $84.12 by Nov 3. Smell gas? Leave the building right away and call 911.",
    "SMELL GAS? Leave the area immediately and call 1-800-555-0100 from a safe place.",
    "If you ever smell gas, leave right away and call us from outside.",
    "If you smell natural gas or hear a hissing sound, get out and call 911.",
    "Gas odor calls are up 30% this fall. Here's what to tell your customers.",
    // Smelly water (Check 36 P1).
    "The hot water smells like rotten eggs since the new heater went in. We're on a well.",
    "Hot water smells like sulfur, cold is fine.",
    "My shower water smells like rotten eggs.",
    // Ordinary gas work.
    "We need a gas line run for the new stove",
    "the gas fireplace won't light",
    "Can you quote a gas leak detector for the basement?",
    // An electrical inspector's red tag is not the gas company's.
    "The inspector red-tagged the panel, we need to fix the bonding.",
  ])("not a gas smell: %s", (t) => expect(mentionsGasSmell(t)).toBe(false));

  it.each([
    "It smells like gas near the stove",
    "No gas smell anymore, thanks!",
    "I smell propane near the grill line",
    "There's a rotten egg smell in the basement",
    "Huele como a gas en la cocina",
    "I think the gas line behind the dryer is leaking, I can hear a hissing sound",
    "There's a rotten egg smell in the basement near the boiler.",
    "We smell propane by the tankless heater.",
    "Propane smell in the utility closet.",
    "I think there's a gas leak at the dryer.",
    "The gas line to the range is hissing.",
    "Gas company shut off our meter and red-tagged the water heater.",
    "smells like gas and the hot water smells weird too",
    "Hay olor a gas en el sótano",
    "Tem cheiro de gás na cozinha",
    "it smells like rotten eggs by the furnace",
    "There's a rotten egg smell near the hot water heater",
    // A real report next to the utility's footer still counts.
    "I smell gas in the kitchen. -- Smell gas? Leave the building and call 911.",
  ])("gas: %s", (t) => expect(mentionsGasSmell(t)).toBe(true));

  it("the water exception is narrow, both ways", () => {
    expect(mentionsWaterSmell("Hot water smells like sulfur, cold is fine.")).toBe(true);
    expect(mentionsWaterSmell("My shower water smells like rotten eggs.")).toBe(true);
    // A gas word anywhere: it's gas.
    expect(mentionsWaterSmell("The water smells like rotten eggs and so does the stove.")).toBe(
      false,
    );
    // An egg smell not next to water: it's gas.
    expect(
      mentionsWaterSmell(
        "The water pressure is low. Also there's a rotten egg smell in the hallway upstairs at night.",
      ),
    ).toBe(false);
    // A water heater is a gas appliance, not water.
    expect(mentionsWaterSmell("Rotten egg smell by the water heater")).toBe(false);
    expect(mentionsWaterSmell("I smell gas")).toBe(false);
  });
});

describe("carbon monoxide (Check 22 P4)", () => {
  it.each([
    "Our carbon monoxide alarm went off twice last night",
    "The CO detector is going off in the basement",
    "co2 detector keeps going off near the boiler",
    "The detector is going off by the furnace and we all have headaches",
    "Carbon monoxide detected, the fire department came",
    "Our CO alarm is beeping and won't stop",
  ])("CO alarm: %s", (t) => expect(mentionsCarbonMonoxide(t)).toBe(true));

  it.each([
    "Can you quote installing smoke and carbon monoxide detectors in every bedroom?",
    "My CO detector keeps chirping, I think it needs a new battery",
    "We need the CO detectors for the smoke certificate inspection",
    "The smoke detector is going off near the furnace when we cook",
  ])("not an alarm: %s", (t) => expect(mentionsCarbonMonoxide(t)).toBe(false));
});

describe("owner rules for gas, CO and smelly water", () => {
  it("CO → needs you, high, CO_REASON; gas still wins over CO", () => {
    expect(rules({ coAlarm: true })).toMatchObject({
      needsOwner: true,
      priority: "high",
      needsOwnerReason: CO_REASON,
      hits: ["co_alarm"],
    });
    expect(rules({ coAlarm: true, gasSmell: true }).needsOwnerReason).toBe(GAS_SMELL_REASON);
  });

  it("smelly water → needs you at normal priority with our fixed words", () => {
    const r = rules(
      { waterSmell: true },
      classification({
        category: "customer_question",
        priority: "high",
        needs_owner: true,
        needs_owner_reason: "Dana's water smells bad.",
      }),
    );
    expect(r).toMatchObject({
      needsOwner: true,
      priority: "normal",
      needsOwnerReason: WATER_SMELL_REASON,
    });
    expect(r.hits).toContain("water_smell");
  });
});

describe("autopilot keeps away from safety threads", () => {
  it("a carbon monoxide alarm always waits", () => {
    expect(guardrailReasons(OK)).toEqual([]);
    expect(guardrailReasons({ ...OK, coAlarm: true }).join()).toMatch(/carbon monoxide/);
  });
});
