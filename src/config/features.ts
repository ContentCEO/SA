/**
 * Feature switches for work that is built but waits on Davi's okay. Every switch is off unless
 * its env var is exactly "1", "true" or "on" (any case). Turn one on in Vercel only with Davi's say-so.
 */
export const FEATURE_ENV = {
  /** Plan #26: "Want to ask if they went another way?" on quiet quotes. ASK DAVI before turning on. */
  closingQuestion: "FEATURE_CLOSING_QUESTION",
} as const;

export type Feature = keyof typeof FEATURE_ENV;

const ON = new Set(["1", "true", "on"]);

export function featureOn(
  name: Feature,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[FEATURE_ENV[name]];
  return raw !== undefined && ON.has(raw.trim().toLowerCase());
}
