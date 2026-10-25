/**
 * Plan #47: the shape of a referral code (12 characters of base64url). Its own module so the
 * browser can check a ?ref= without loading the server's referral rules (Check 29 P3); the
 * server action still checks it again (`isReferralCode` via referral-rules, waitlist.ts).
 */
const CODE = /^[A-Za-z0-9_-]{12}$/;

export function isReferralCode(v: unknown): v is string {
  return typeof v === "string" && CODE.test(v);
}
