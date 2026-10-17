/**
 * Check 38 P6: the owner's registration and license numbers (`business_profile.licenses`), as
 * they typed them. Drafts quote only these, exactly; the draft check flags any other number
 * and any "we're registered / licensed / lead-safe certified / insured" the owner hasn't backed.
 * Never shown on the public site (Davi: no license number published until confirmed).
 */
export type Licenses = {
  /** Home improvement contractor registration (HIC) number. */
  hic_number?: string;
  /** When the HIC registration runs out (YYYY-MM-DD). */
  hic_expires_on?: string;
  /** Construction supervisor license (CSL). */
  csl_number?: string;
  /** Lead-safe renovation license. */
  lead_safe_license?: string;
  /** Insurance company. */
  insurance_carrier?: string;
};

export const LICENSE_FIELD_MAX = 40;

/** The labels the owner sees, also used for the drafting block. */
export const LICENSE_LABELS = {
  hic_number: "Home improvement registration (HIC) number",
  csl_number: "Construction supervisor license (CSL)",
  lead_safe_license: "Lead-safe renovation license",
  insurance_carrier: "Insurance company",
} as const;

/** The filled ones as one line for the drafting context and the draft check, or null. */
export function licenseFacts(l: Licenses | null | undefined): string | null {
  if (!l) return null;
  const parts = (Object.keys(LICENSE_LABELS) as (keyof typeof LICENSE_LABELS)[])
    .filter((k) => l[k]?.trim())
    .map((k) => `${LICENSE_LABELS[k]}: ${l[k]!.trim()}`);
  return parts.length ? parts.join("; ") : null;
}

/** Days until the HIC registration runs out (negative = already out), or null when unknown. */
export function hicDaysLeft(l: Licenses | null | undefined, today: string): number | null {
  const end = l?.hic_expires_on;
  if (!end || !/^\d{4}-\d{2}-\d{2}$/.test(end) || !/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  return Math.round(
    (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}

/** Settings' one line when the HIC registration runs out within 30 days (no email). */
export function hicExpiryLine(l: Licenses | null | undefined, today: string): string | null {
  const days = hicDaysLeft(l, today);
  if (days === null || days > 30) return null;
  if (days < 0)
    return "Your HIC registration date has passed. Renew it with the state, then update it here.";
  if (days === 0) return "Your HIC registration runs out today. Renew it with the state.";
  return `Your HIC registration runs out in ${days} day${days === 1 ? "" : "s"}. Renew it with the state.`;
}
