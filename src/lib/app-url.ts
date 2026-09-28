/**
 * Absolute app URL, no trailing slash. `APP_URL` is set for production; Vercel
 * preview builds fall back to their stable per-branch URL. Never hardcoded.
 */
export function appUrl(path = "", env: Record<string, string | undefined> = process.env): string {
  const base =
    env.APP_URL ||
    (env.VERCEL_BRANCH_URL ? `https://${env.VERCEL_BRANCH_URL}` : "") ||
    "http://localhost:3000";
  return `${base.replace(/\/+$/, "")}${path}`;
}
