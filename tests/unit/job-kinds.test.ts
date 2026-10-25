import { describe, expect, it } from "vitest";
import { JOB_KINDS, OTHER_JOB_KIND } from "@/config/job-kinds";
import type { Trade } from "@/config/trades";
import { jobKindOf } from "@/server/monthly-rules";

/** Wave 2 job-kind lists: each phrase from the review runs, with its fixed label. */
const CASES: [Trade, string, string][] = [
  // Check 36 P9: plumbing.
  ["plumbing", "sump pump replacement", "Sump and ejector pumps"],
  ["plumbing", "sewage ejector pump", "Sump and ejector pumps"],
  ["plumbing", "irrigation backflow test", "Backflow tests"],
  ["plumbing", "backflow preventer test", "Backflow tests"],
  ["plumbing", "boiler replacement", "Boilers and heating"],
  ["plumbing", "well pump not working", "Wells and water treatment"],
  ["plumbing", "water softener install", "Wells and water treatment"],
  ["plumbing", "expansion tank", "Valves and tanks"],
  ["plumbing", "main shutoff valve replacement", "Valves and tanks"],
  ["plumbing", "T&P valve dripping", "Valves and tanks"],
  ["plumbing", "inspection report repairs, 12 plumbing items", "Home sale repairs"],
  ["plumbing", "frozen pipe, no water at kitchen sink", "Frozen pipes"],
  ["plumbing", "no hot water", "Water heaters"],
  ["plumbing", "kitchen sink faucet", "Fixtures"],
  ["plumbing", "leaking pipe under the sink", "Leaks"],
  // Check 37 P7: electrical.
  ["electrical", "Tesla Powerwall battery with existing solar panels", "Solar and batteries"],
  ["electrical", "solar panel interconnection", "Solar and batteries"],
  ["electrical", "phone charger outlet with USB", "Outlets and circuits"],
  ["electrical", "smoke and CO detectors for home sale", "Smoke and CO detectors"],
  ["electrical", "Tesla Wall Connector", "EV chargers"],
  ["electrical", "200 amp panel upgrade", "Panel upgrades"],
  ["electrical", "EV charger in the garage", "EV chargers"],
  ["electrical", "Tesla wall charger", "EV chargers"],
  // Check 38 P8: remodeling.
  ["remodeling", "finish basement with bathroom and bar", "Basements"],
  ["remodeling", "shower grout cracking, door sticking", "Callbacks and touch-ups"],
  ["remodeling", "mudroom off the garage", "Additions"],
  ["remodeling", "kitchen addition", "Additions"],
  ["remodeling", "kitchen remodel", "Kitchens"],
  ["remodeling", "touch-up on the trim from last month", "Callbacks and touch-ups"],
  ["remodeling", "bathroom remodel", "Bathrooms"],
  // Check 39 P7: hvac.
  ["hvac", "dehumidifier install", "Air quality and humidity"],
  ["hvac", "whole-house humidifier", "Air quality and humidity"],
  ["hvac", "air quality, UV light", "Air quality and humidity"],
  ["hvac", "ERV ventilation", "Air quality and humidity"],
  ["hvac", "rooftop unit service contract", "Commercial service"],
  ["hvac", "heat isn't working", "Furnaces and boilers"],
  ["hvac", "heat pump water heater", "Water heaters"],
  ["hvac", "furnace tune-up", "Maintenance and tune-ups"],
  ["hvac", "AC tune-up", "Maintenance and tune-ups"],
  ["hvac", "duct cleaning", "Ductwork and vents"],
  ["hvac", "new heat pump", "AC and heat pumps"],
  ["hvac", "oil burner service", "Furnaces and boilers"],
  ["hvac", "smart thermostat", "Thermostats"],
  ["hvac", "AC not cooling", "AC and heat pumps"],
  ["hvac", "strange noise from the unit", "Repairs"],
  // Check 40 P5: roofing.
  ["roofing", "vinyl siding replacement, loose gutter", "Siding"],
  ["roofing", "siding repair", "Siding"],
  ["roofing", "hail damage to siding and gutters", "Siding"],
  ["roofing", "ice dams", "Ice dams"],
  ["roofing", "metal roof install", "Metal roofs"],
  ["roofing", "attic ventilation, ridge vent", "Ventilation"],
  ["roofing", "roof snow removal", "Roof snow removal"],
  ["roofing", "roof certification for home sale", "Roof certifications"],
  ["roofing", "new gutters and roof", "Roof replacements"],
  ["roofing", "replace the gutters", "Gutters"],
  ["roofing", "leaking around the chimney", "Skylights and chimneys"],
  // Check 41 P8: landscaping and painting.
  ["landscaping", "tick spraying and grub control", "Lawn treatments"],
  ["landscaping", "mosquito treatment", "Lawn treatments"],
  ["landscaping", "weed control", "Lawn treatments"],
  ["landscaping", "overseeding", "Lawn care"],
  ["landscaping", "dethatching", "Lawn care"],
  ["landscaping", "gutter cleaning", "Cleanups"],
  ["landscaping", "fence install", "Fences"],
  ["landscaping", "fall cleanup, leaves, plus weekly mowing next year", "Cleanups"],
  ["landscaping", "weekly mowing", "Lawn care"],
  ["painting", "power washing vinyl siding", "Power washing"],
  ["painting", "pressure wash the house", "Power washing"],
  ["painting", "epoxy garage floor", "Floors"],
  ["painting", "paint the exterior", "Exterior painting"],
];

describe("wave 2 job kinds", () => {
  it.each(CASES)("%s: %s → %s", (trade, service, label) => {
    expect(jobKindOf(trade, service)).toBe(label);
  });

  it("none of the review's phrases is 'Other jobs'", () => {
    for (const [trade, service] of CASES)
      expect(jobKindOf(trade, service)).not.toBe(OTHER_JOB_KIND);
  });

  it("labels stay fixed: no label repeats within a trade, and none is the customer's words", () => {
    for (const kinds of Object.values(JOB_KINDS)) {
      const labels = kinds.map((k) => k.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
    for (const [trade, service] of CASES) {
      const labels = JOB_KINDS[trade].map((k) => k.label);
      expect([...labels, OTHER_JOB_KIND]).toContain(jobKindOf(trade, service));
    }
  });
});
