import type { TradePrompt } from "./types";

/**
 * Check 37 P4 (wave 2): the words owners, customers and the town's Inspector of Wires use, and
 * the questions that decide EV and service-upgrade prices. Never asks the customer whether a
 * permit or inspection is involved — in Massachusetts the electrician notifies the inspector
 * (M.G.L. c.143 §3L); the drafter asks for the town instead. No rebate amounts, code editions or
 * license numbers here: those belong in the owner's profile.
 */
export const electrical: TradePrompt = {
  name: "electrical",
  vocabulary: [
    "panel upgrade",
    "service size (100 / 200 amp)",
    "breaker vs. fuse box",
    "GFCI / AFCI",
    "circuit and dedicated circuit",
    "EV charger",
    "rough-in and trim-out",
    "knob and tube",
    "aluminum branch wiring",
    "Federal Pacific / Zinsco panels",
    "Inspector of Wires (the town's electrical inspector)",
    "cut and reconnect / cut-in with the utility",
    "utility work request number",
    "meter socket / meter-main",
    "outdoor emergency disconnect",
    "load calculation",
    "interlock / transfer switch",
    "interconnection and permission to operate (solar)",
    "permit and inspection",
    "callback",
  ],
  quoteQuestions: [
    "the job address",
    "the town the job is in",
    "what they want done (outlets, lights, panel, EV charger…)",
    "a photo of the panel with the door open",
    "current service size (100 or 200 amp), if they know",
    "for EV chargers: the car, whether they already have a charger, and how far the parking spot is from the panel",
    "for service upgrades: wires from a pole or underground, and where the meter is",
    "big appliances in the house (electric range, dryer, AC or heat pump, well pump, hot tub)",
    "anything that can't lose power for a few hours (medical equipment, sump pump)",
    "age of the house",
    "access: attic, basement, finished walls",
  ],
};
