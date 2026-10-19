import type { TradePrompt } from "./types";

/**
 * Check 39 P6 (wave 2): boiler, oil and heat-pump country. The old questions treated every
 * request as a ducted replacement; these ask what heats the house now, the fuel, zones, backup
 * heat and the panel. Program names that are Massachusetts-only (Mass Save, HEAT Loan, Home
 * Energy Assessment) live in prompts/states/ma.ts. No rebate amounts or refrigerant rules here:
 * the drafting prompt says to state none as fact unless the owner's profile does.
 */
export const hvac: TradePrompt = {
  name: "HVAC (heating and cooling)",
  vocabulary: [
    "furnace",
    "boiler (oil or gas), oil burner, radiators and baseboard, hydronic",
    "heat pump / mini-split",
    "zones and heads (mini-splits)",
    "backup heat / dual fuel / integrated controls",
    "AC condenser and air handler",
    "tonnage",
    "SEER rating",
    "ENERGY STAR Cold Climate",
    "ductwork",
    "thermostat",
    "refrigerant",
    "R-410A, R-454B, R-32 (A2L) refrigerants",
    "condensate line and pump",
    "tune-up / maintenance plan",
    "load calculation (Manual J)",
  ],
  quoteQuestions: [
    "the job address",
    "what's wrong or what they want (no heat, no cooling, replacement, new install)",
    "make, model and age of the current equipment (a photo of the label helps)",
    "what heats the house now: a furnace with ducts, or a boiler with radiators or baseboard, and the fuel (gas, oil, propane, electric)",
    "for heat pumps: which rooms or how many zones, whether they'll keep the old system as backup, whether they've had a home energy assessment, and the main electric panel size",
    "whether anyone is without heat or cooling right now",
  ],
};
