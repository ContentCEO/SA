/**
 * Check 15 P9: a stored calendar date ("2026-11-30") as people read it: "Sun, Nov 30", with the
 * year only when it isn't this year. A plain date: no time zone can move it a day.
 */
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function plainDate(ymd: string, today: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCMonth() !== mo - 1) return ymd;
  const sameYear = today.slice(0, 4) === m[1];
  return `${WEEKDAYS[day.getUTCDay()]}, ${MONTHS[mo - 1]} ${d}${sameYear ? "" : `, ${y}`}`;
}

/** "Until Sun, Nov 30" */
export function untilLine(ymd: string, today: string): string {
  return `Until ${plainDate(ymd, today)}`;
}
