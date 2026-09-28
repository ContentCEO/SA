/** Absolute app URL from env (never hardcoded), no trailing slash. */
export function appUrl(path = ""): string {
  const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${path}`;
}
