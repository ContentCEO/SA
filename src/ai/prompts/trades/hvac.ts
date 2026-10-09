import type { TradePrompt } from "./types";

export const hvac: TradePrompt = {
  name: "HVAC (heating and cooling)",
  vocabulary: [
    "furnace",
    "heat pump / mini-split",
    "AC condenser and air handler",
    "tonnage",
    "SEER rating",
    "ductwork",
    "thermostat",
    "refrigerant",
    "tune-up / maintenance plan",
    "load calculation (Manual J)",
  ],
  quoteQuestions: [
    "the job address",
    "what's wrong or what they want (no heat, no cooling, replacement, new install)",
    "make, model and age of the current equipment (a photo of the label helps)",
    "fuel type: gas, oil, electric, propane",
    "size of the home in square feet",
    "whether there's existing ductwork",
    "whether anyone is without heat or cooling right now",
  ],
};
