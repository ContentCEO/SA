/**
 * Check 2 P3: the hidden trap field on both public forms (waitlist and Growth). People never see
 * it; bots fill it in. It was called "website", which a browser or password manager may autofill,
 * so it's now `sa_hp` (labelled "Leave this empty"). A page loaded before the rename still posts
 * "website", so both count. Pure (no "server-only").
 */
export const TRAP_FIELD = "sa_hp";
const LEGACY_TRAP_FIELD = "website";

export function trapWasFilled(form: { get(name: string): unknown }): boolean {
  return [TRAP_FIELD, LEGACY_TRAP_FIELD].some((k) => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() !== "";
  });
}
