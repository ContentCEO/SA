/**
 * Check 37 P2: an inspector's facts carried from one email to the next on the same thread, like
 * the invoice facts. Pure.
 */
export type PermitFacts = {
  issuing_body: string | null;
  permit_number: string | null;
  inspection_at: string | null;
  result: "passed" | "failed" | "scheduled" | "other" | null;
  corrections: string[];
};

const norm = (v: string | null | undefined) =>
  (v ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .trim();

/**
 * - Nothing about a permit in this email → keep what's stored.
 * - The same permit (same number, or a number missing on either side and the same issuing
 *   body) → this email's result, inspection time and issuing body where it gives them; the fix
 *   list stays until the permit passes (cleared then), and is replaced when the town lists new
 *   corrections.
 * - A different permit → this email's facts.
 */
export function carryPermitFacts(
  prev: PermitFacts | null | undefined,
  now: PermitFacts | null | undefined,
): PermitFacts | null {
  if (!now) return prev ?? null;
  if (!prev) return now;
  const a = norm(prev.permit_number);
  const b = norm(now.permit_number);
  const bodyA = norm(prev.issuing_body);
  const same = a && b ? a === b : bodyA !== "" && bodyA === norm(now.issuing_body);
  if (!same) return now;
  const corrections =
    now.result === "passed"
      ? []
      : (now.corrections ?? []).length
        ? now.corrections
        : (prev.corrections ?? []);
  return {
    issuing_body: now.issuing_body ?? prev.issuing_body,
    permit_number: now.permit_number ?? prev.permit_number,
    inspection_at: now.inspection_at ?? prev.inspection_at,
    result: now.result ?? prev.result,
    corrections,
  };
}

/** Check 37 P2: the stored permit facts on a thread, or null. */
export function permitOf(extracted: unknown): PermitFacts | null {
  const p = (extracted as { permit?: unknown } | null | undefined)?.permit;
  if (!p || typeof p !== "object") return null;
  const x = p as Partial<PermitFacts>;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null);
  const results = ["passed", "failed", "scheduled", "other"] as const;
  return {
    issuing_body: str(x.issuing_body),
    permit_number: str(x.permit_number),
    inspection_at: str(x.inspection_at),
    result: results.includes(x.result as never) ? (x.result as PermitFacts["result"]) : null,
    corrections: Array.isArray(x.corrections)
      ? x.corrections.filter((c): c is string => typeof c === "string")
      : [],
  };
}
