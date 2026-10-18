/**
 * Check 22 P2: the owner's "This is a normal email" on a card marked as trying to instruct the
 * assistant. Pure rules (no database).
 */

/** After the owner clears a mark, autopilot stays away from the thread this long. */
export const INJECTION_CLEARED_AUTOPILOT_DAYS = 30;

/** Codes that are never ordinary mail: hidden characters or an encoded block. */
const NEVER_CLEARABLE = ["hidden", "encoded"];

/**
 * The owner may clear the mark only when it is set, the reasons were recorded (older rows
 * weren't: refused), and none of them is hidden or encoded text.
 */
export function injectionClearable(extracted: unknown): boolean {
  const x = (extracted ?? {}) as { injection?: unknown; injection_reasons?: unknown };
  if (x.injection !== true || !Array.isArray(x.injection_reasons)) return false;
  return !x.injection_reasons.some((r) => NEVER_CLEARABLE.includes(String(r)));
}

/** The owner cleared an attack mark on this thread in the last 30 days. */
export function injectionClearedRecently(extracted: unknown, now: Date): boolean {
  const x = (extracted ?? {}) as { injection_cleared_at?: unknown };
  if (typeof x.injection_cleared_at !== "string") return false;
  const at = Date.parse(x.injection_cleared_at);
  return Number.isFinite(at) && now.getTime() - at < INJECTION_CLEARED_AUTOPILOT_DAYS * 86_400_000;
}

type Stored = {
  needs_owner: boolean;
  reason: string | null;
  priority: "high" | "normal" | "low";
  hits: string[];
};

/**
 * The thread's facts once the mark is gone: what the owner rules said without it (kept at
 * classification as `without_injection`), or an ordinary card if nothing was kept. The
 * owner's own "This one needs me" always stands.
 */
export function clearedFacts(
  extracted: Record<string, unknown>,
  manual: { needsOwnerManual: boolean; needsOwnerReason: string | null },
  now: Date,
): {
  extracted: Record<string, unknown>;
  needsOwner: boolean;
  needsOwnerReason: string | null;
  priority: "high" | "normal" | "low" | null;
} {
  const w = extracted.without_injection as Stored | undefined;
  const rest = { ...extracted };
  delete rest.injection;
  delete rest.injection_reasons;
  delete rest.without_injection;
  const next = {
    ...rest,
    owner_rule_hits: w?.hits ?? [],
    injection_cleared_by_owner: true,
    injection_cleared_at: now.toISOString(),
  };
  const needsOwner = manual.needsOwnerManual || (w?.needs_owner ?? false);
  return {
    extracted: next,
    needsOwner,
    needsOwnerReason: manual.needsOwnerManual
      ? manual.needsOwnerReason
      : needsOwner
        ? (w?.reason ?? null)
        : null,
    priority: w?.priority ?? null,
  };
}
