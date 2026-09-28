/** Days we keep email bodies before purging them (metadata and summaries are kept). */
export function bodyRetentionDays(): number {
  const n = Number(process.env.RETENTION_BODY_DAYS ?? 30);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 30;
}
