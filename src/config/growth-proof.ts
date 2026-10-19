/**
 * Check 2 P6: real proof for /growth, never invented. Empty until a client gives written
 * permission. Each item needs the date the client said yes (`permissionOn`) and the date the operator last
 * checked it's still true (`checkedOn`, both "YYYY-MM-DD"). Items not checked in the last 12
 * months are hidden (`liveProof`). Nothing here comes from anyone's inbox.
 */
export type GrowthProofItem = {
  kind: "quote" | "before_after" | "link";
  /** The client's business name, as they okayed it. */
  shop: string;
  town: string;
  /** The client's own words (kind "quote"), or a caption. */
  text?: string;
  /** Paths under public/ (kind "before_after"). */
  images?: string[];
  /** A page anyone can check (kind "link"), https only. */
  href?: string;
  permissionOn: string;
  checkedOn: string;
};

export const GROWTH_PROOF: GrowthProofItem[] = [];

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in "YYYY-MM-DD" form (UTC midnight), or null. */
export function proofDate(v: string): Date | null {
  const m = DAY.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v ? d : null;
}

/** Items with valid dates, checked within the last 12 months of `now`. */
export function liveProof(items: readonly GrowthProofItem[], now: Date): GrowthProofItem[] {
  const cutoff = new Date(now);
  cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
  return items.filter((i) => {
    const checked = proofDate(i.checkedOn);
    return (
      proofDate(i.permissionOn) !== null && checked !== null && checked >= cutoff && checked <= now
    );
  });
}
