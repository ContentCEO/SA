/**
 * Feature switches for work built behind a switch. Every switch is off unless its env var is
 * exactly "1", "true" or "on" (any case): the code default stays off, and the env var is the
 * switch. Turn one on or off in Vercel only with Davi's say-so.
 */
export const FEATURE_ENV = {
  /**
   * Plan #26: "Want to ask if they went another way?" on quiet quotes. Turned on by Davi 2026-10-14:
   * FEATURE_CLOSING_QUESTION=1 in Vercel on Production and Preview, live from the next deploy.
   */
  closingQuestion: "FEATURE_CLOSING_QUESTION",
  /**
   * Plan #47: referral links and a Stripe balance credit once per referral. Off until Davi picks
   * the amount and who gets it — and even when on, nothing happens while REFERRAL_CREDIT_CENTS
   * (src/config/pricing.ts) is null. ASK DAVI before turning on.
   */
  referrals: "FEATURE_REFERRALS",
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
