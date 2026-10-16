import { createHash, randomBytes } from "node:crypto";
import { featureOn } from "@/config/features";
import { REFERRAL_CREDIT_CENTS, REFERRAL_CREDIT_TO } from "@/config/pricing";
import type { ReferralSide } from "@/db/schema";
import { appUrl } from "@/lib/app-url";
import { PUBLIC_WEBMAIL_DOMAINS } from "./sender-rules";

/**
 * Plan #47 referral credit — pure rules. Everything is off unless FEATURE_REFERRALS is on AND
 * a positive whole number of cents is set in src/config/pricing.ts (null today: ASK DAVI).
 */

/** Owners on these share a domain with strangers, so the same-domain block doesn't apply. */
export { PUBLIC_WEBMAIL_DOMAINS };

/** 12 characters of base64url: 9 random bytes, nothing about the owner in it. */
const CODE = /^[A-Za-z0-9_-]{12}$/;

export function isReferralCode(v: unknown): v is string {
  return typeof v === "string" && CODE.test(v);
}

export function newReferralCode(): string {
  return randomBytes(9).toString("base64url");
}

/** The link an owner shares: the app's home page with their code, and nothing else. */
export function referralLink(
  code: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return `${appUrl("/", env)}?ref=${encodeURIComponent(code)}`;
}

/**
 * A Postgres unique violation (23505), from the driver directly or wrapped by Drizzle. Only
 * this may be retried when making a code; anything else (a dropped connection) is rethrown.
 */
export function isUniqueViolation(err: unknown): boolean {
  for (let e = err as { code?: unknown; cause?: unknown } | null, i = 0; e && i < 5; i++) {
    if (e.code === "23505") return true;
    e = e.cause as typeof e;
  }
  return false;
}

type Party = { workspaceId: string; ownerEmail: string };

function domainOf(email: string): string {
  return email.trim().toLowerCase().split("@").pop() ?? "";
}

/**
 * Why a referral can't count, or null if it can. Referring yourself (same workspace or same
 * owner email) never counts; nor do two owners at the same business domain (a@shop.com and
 * b@shop.com) — but two unrelated gmail.com owners are fine.
 */
export function referralRefusal(referrer: Party, referred: Party): "self" | "same_domain" | null {
  if (referrer.workspaceId === referred.workspaceId) return "self";
  const a = referrer.ownerEmail.trim().toLowerCase();
  const b = referred.ownerEmail.trim().toLowerCase();
  if (a === b) return "self";
  const da = domainOf(a);
  if (da && da === domainOf(b) && !PUBLIC_WEBMAIL_DOMAINS.has(da)) return "same_domain";
  return null;
}

export type ReferralCreditTo = "both" | "referrer" | "referred";
type ReferralConfig = { cents: number | null; to: ReferralCreditTo };

let testConfig: ReferralConfig | undefined;

/** Tests only (A30): stand in for the amount and who gets it. Pass undefined to reset. */
export function setReferralConfigForTests(config: ReferralConfig | undefined) {
  testConfig = config;
}

const SIDES: Record<ReferralCreditTo, ReferralSide[]> = {
  both: ["referrer", "referred"],
  referrer: ["referrer"],
  referred: ["referred"],
};

/**
 * What a referral pays right now, or null when it pays nothing: the switch is off, or the
 * amount isn't a positive whole number of cents.
 */
export function referralCredit(
  env: Record<string, string | undefined> = process.env,
  amount: number | null = testConfig ? testConfig.cents : REFERRAL_CREDIT_CENTS,
  to: ReferralCreditTo = testConfig ? testConfig.to : REFERRAL_CREDIT_TO,
): { cents: number; sides: ReferralSide[] } | null {
  if (!featureOn("referrals", env)) return null;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0) return null;
  return { cents: amount, sides: [...(SIDES[to] ?? [])] };
}

/** Whether anything about referrals shows or is recorded at all. */
export function referralsVisible(env: Record<string, string | undefined> = process.env): boolean {
  return referralCredit(env) !== null;
}

/**
 * The durable "who was referred" key (A5): sha256 of the normalized email, salted with
 * AUTH_SECRET like the waitlist IP hash, so the raw address isn't kept after deletion.
 */
export function referredEmailHash(
  email: string,
  salt: string = process.env.AUTH_SECRET ?? "",
): string {
  return createHash("sha256")
    .update(`${salt}:referral:${email.trim().toLowerCase()}`)
    .digest("hex");
}

/** Stripe errors that will never succeed on a retry (deleted customer, bad request). */
export function isPermanentStripeError(err: unknown): boolean {
  const e = err as { type?: unknown; code?: unknown } | null;
  return (
    !!e &&
    (e.code === "resource_missing" ||
      e.type === "StripeInvalidRequestError" ||
      e.type === "invalid_request_error")
  );
}

/** A Stripe error code is a fixed snake_case word; anything else is stored as the error's name. */
export function errorCodeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[a-z_]{1,64}$/.test(code)) return code;
  return err instanceof Error ? err.name.slice(0, 64) : "unknown";
}
