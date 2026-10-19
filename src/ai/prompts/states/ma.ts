import type { StatePrompt } from "./types";

/**
 * Massachusetts (Check 44 P1 + 45 P2): the home improvement contractor registration (HIC, c.142A)
 * and the construction supervisor license (CSL, c.143) are Massachusetts names. Remodelers and
 * carpenters working on existing homes hear them daily; nobody in Ohio or Texas does.
 */
export const ma: StatePrompt = {
  vocabulary: {
    remodeling: [
      "home improvement contract (HIC)",
      "HIC registration number",
      "construction supervisor license (CSL)",
    ],
    carpentry: ["home improvement contract (HIC)", "construction supervisor license (CSL)"],
    // Check 36 P8 / 39 P6: the state's energy programs, by name only (never an amount).
    plumbing: ["Mass Save"],
    hvac: ["Mass Save, HEAT Loan, Home Energy Assessment", "Mass Save heat pump installer network"],
  },
};
