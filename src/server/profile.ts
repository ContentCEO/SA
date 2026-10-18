import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { LICENSE_FIELD_MAX, type Licenses } from "@/config/licenses";
import { cleanExtraTrades, MAX_EXTRA_TRADES, TRADES, type Trade } from "@/config/trades";
import { US_STATE_CODES } from "@/config/us-states";
import { db } from "@/db";
import {
  activityLog,
  businessProfiles,
  voiceProfiles,
  workspaces,
  type BusinessProfile,
  type VoiceProfile,
} from "@/db/schema";
import { normalizeTown } from "./service-area-rules";
import { orStored, unknownStored } from "./stored-value-rules";

/** Textareas: trim, cap, empty → null. */
const longText = (max = 2000) =>
  z
    .string()
    .trim()
    .max(max, `Keep this under ${max} characters.`)
    .transform((v) => (v === "" ? null : v));

/** One item per line, trimmed, blanks dropped, de-duplicated. */
const lines = (maxItems: number, maxLen = 200) =>
  z
    .string()
    .transform((v) => [
      ...new Set(
        v
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    ])
    .pipe(
      z
        .array(z.string().max(maxLen, `Keep each line under ${maxLen} characters.`))
        .max(maxItems, `Up to ${maxItems} lines.`),
    );

export const MAX_CREW_ADDRESSES = 30;

/**
 * Check 50 P3: the owner's crew addresses (`business_profile.crew_addresses`), one per line:
 * each an email, lowercased, de-duplicated after lowercasing, at most 30. Not in any form yet.
 */
export const crewAddressesSchema = z
  .string()
  .transform((v) =>
    v
      .split("\n")
      .map((l) => l.trim().toLowerCase())
      .filter(Boolean),
  )
  .pipe(
    z.array(
      z
        .string()
        .max(254, "Keep each line under 254 characters.")
        .email("Each line should be one email address."),
    ),
  )
  .transform((list) => [...new Set(list)])
  .pipe(z.array(z.string()).max(MAX_CREW_ADDRESSES, `Up to ${MAX_CREW_ADDRESSES} addresses.`));

export const REVIEW_URL_MESSAGE =
  "That doesn't look like a web link. Copy it from your Google or Yelp page — it starts with https://";

/**
 * Plan #29 review link: '' → null (cleared); otherwise an https link to a real host name.
 * A missing key stays undefined so a save that doesn't carry the field never wipes it.
 */
const httpsLink = z.url({ protocol: /^https$/, hostname: z.regexes.domain });
// The URL parser silently drops tabs/newlines and allows spaces, but we store the text as typed and
// later put it in a customer email — so anything that isn't part of a link ("…/review Thanks!",
// a pasted second line, quotes or angle brackets) is refused here.
const NOT_IN_A_LINK = /[\s\u0000-\u001f\u007f"<>`]/;
const reviewUrl = z
  .string()
  .trim()
  .max(500, "Keep this under 500 characters.")
  .transform((v) => (v === "" ? null : v))
  // One refine (not z.url's own checks) so a bad link shows the message once, not per failed rule.
  .refine(
    (v) => v === null || (!NOT_IN_A_LINK.test(v) && httpsLink.safeParse(v).success),
    REVIEW_URL_MESSAGE,
  )
  .optional();

/** Check 38 P6: one short line each; '' clears it. Left out = leave the saved one as it is. */
const licenseLine = z
  .string()
  .trim()
  .max(LICENSE_FIELD_MAX, `Keep this under ${LICENSE_FIELD_MAX} characters.`)
  .optional();
const licenseDate = z
  .string()
  .trim()
  .refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v), "Pick the date it runs out.")
  .optional();

const tradeField = z.enum(TRADES, { message: "Pick your trade." });
const stateField = z
  .string()
  .trim()
  .toUpperCase()
  .refine(
    (v) => v === "" || (US_STATE_CODES as readonly string[]).includes(v),
    "Pick your state from the list.",
  )
  .transform((v) => (v === "" ? null : v));

export const businessProfileInput = z.object({
  businessName: z.string().trim().min(1, "What's the business called?").max(120),
  trade: tradeField,
  /**
   * Round 2 (TW A4): up to two more trades, as the form's ticked boxes joined by commas.
   * Left out entirely = leave them as they are.
   */
  extraTrades: z
    .preprocess(
      (v) =>
        typeof v === "string"
          ? v
              .split(",")
              .map((x) => x.trim())
              .filter(Boolean)
          : v,
      z
        .array(z.enum(TRADES, { message: "Pick from the list." }))
        .max(MAX_EXTRA_TRADES, "Pick up to two more trades."),
    )
    .optional(),
  services: z.string().trim().min(1, "Tell us what work you do.").max(2000),
  serviceArea: longText(),
  /**
   * Leads package (B9): "Towns you work in", one per line, de-duplicated by town name. Left out
   * entirely (a form without the field) = leave the list as it is.
   */
  serviceTowns: lines(100, 60)
    .transform((list) => {
      const seen = new Set<string>();
      return list.filter((t) => {
        const key = JSON.stringify(normalizeTown(t));
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    })
    .optional(),
  hours: longText(500),
  leadTime: longText(500),
  pricingNotes: longText(),
  paymentTerms: longText(1000),
  policies: longText(),
  signature: longText(500),
  reviewUrl,
  doNotPromise: lines(30),
  vipSenders: lines(50, 254).pipe(
    z.array(z.string().toLowerCase().email("Each VIP line should be one email address.")),
  ),
  /**
   * Check 38 P2: "Which state do you work in?" — two letters, '' = not set. Left out = leave it.
   * Massachusetts turns on the one-third deposit warning.
   */
  state: stateField.optional(),
  // Check 38 P6: "Licenses and registrations".
  hicNumber: licenseLine,
  hicExpiresOn: licenseDate,
  cslNumber: licenseLine,
  leadSafeLicense: licenseLine,
  insuranceCarrier: licenseLine,
  amountThresholdDollars: z.coerce
    .number({ message: "Enter a dollar amount." })
    .int("Whole dollars, please.")
    .min(0)
    .max(10_000_000),
  /**
   * Round 2 (FW C10): the browser's time zone, sent by the setup form only. Anything that isn't
   * a real zone is dropped (left as it was), never an error.
   */
  timeZone: z
    .string()
    .trim()
    .max(64)
    .refine((tz) => isTimeZone(tz))
    .optional()
    .catch(undefined),
});
export type BusinessProfileInput = z.input<typeof businessProfileInput>;

/**
 * Check 30 P3: the form's schema for one shop. A trade or state stored by newer code (not in
 * this code's lists) is accepted when posted back unchanged; any other unknown value is refused.
 */
export function businessProfileInputFor(stored: { trade?: string | null; state?: string | null }) {
  return businessProfileInput.extend({
    trade: orStored(tradeField, stored.trade),
    state: orStored(stateField, stored.state).optional(),
  });
}

export async function getBusinessProfile(
  workspaceId: string,
): Promise<BusinessProfile | undefined> {
  const [row] = await db()
    .select()
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  return row;
}

export async function saveBusinessProfile(
  workspaceId: string,
  data: z.output<typeof businessProfileInput>,
  now: Date = new Date(),
) {
  const {
    businessName,
    trade,
    extraTrades,
    timeZone,
    hicNumber,
    hicExpiresOn,
    cslNumber,
    leadSafeLicense,
    insuranceCarrier,
    ...rest
  } = data;
  // Check 38 P6: a form that shows the license fields sends all of them; one that doesn't
  // leaves the saved numbers alone.
  const licenseInput = { hicNumber, hicExpiresOn, cslNumber, leadSafeLicense, insuranceCarrier };
  const licenses: Licenses | undefined = Object.values(licenseInput).some((v) => v !== undefined)
    ? Object.fromEntries(
        (
          [
            ["hic_number", hicNumber],
            ["hic_expires_on", hicExpiresOn],
            ["csl_number", cslNumber],
            ["lead_safe_license", leadSafeLicense],
            ["insurance_carrier", insuranceCarrier],
          ] as const
        ).filter(([, v]) => v),
      )
    : undefined;
  const profile = { ...rest, ...(timeZone ? { timeZone } : {}), ...(licenses ? { licenses } : {}) };
  // Check 30 P3: an extra trade stored by newer code has no box on this form, so it can't have
  // been unticked: keep it.
  const keptExtra = extraTrades
    ? unknownStored(
        (
          await db()
            .select({ extraTrades: workspaces.extraTrades })
            .from(workspaces)
            .where(eq(workspaces.id, workspaceId))
        )[0]?.extraTrades,
        TRADES,
      )
    : [];
  await db()
    .update(workspaces)
    .set({
      businessName,
      trade,
      ...(extraTrades
        ? {
            extraTrades: [...keptExtra, ...cleanExtraTrades(extraTrades, trade)] as Trade[],
          }
        : {}),
    })
    .where(eq(workspaces.id, workspaceId));
  await db()
    .insert(businessProfiles)
    .values({ workspaceId, ...profile, completedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: businessProfiles.workspaceId,
      set: { ...profile, updatedAt: now },
    });
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "business_profile_saved",
    detail: {},
  });
}

export const FOLLOWUP_DAY_CHOICES = [2, 3, 4, 5, 7] as const;

export const followupSettingsInput = z.object({
  enabled: z
    .literal("on")
    .optional()
    .transform((v) => v === "on"),
  days: z.coerce.number().refine((n) => (FOLLOWUP_DAY_CHOICES as readonly number[]).includes(n), {
    message: "Pick how many days to wait.",
  }),
});

/** Follow-up settings live on the business profile row; create it if needed. */
export async function saveFollowupSettings(
  workspaceId: string,
  data: z.output<typeof followupSettingsInput>,
  now: Date = new Date(),
) {
  const set = { followupsEnabled: data.enabled, followupDays: data.days, updatedAt: now };
  await db()
    .insert(businessProfiles)
    .values({ workspaceId, ...set })
    .onConflictDoUpdate({ target: businessProfiles.workspaceId, set });
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "followup_settings_saved",
      detail: { enabled: data.enabled, days: data.days },
    });
}

export const DIGEST_HOURS = [5, 6, 7, 8, 9] as const;

function isTimeZone(tz: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const digestSettingsInput = z.object({
  enabled: z
    .literal("on")
    .optional()
    .transform((v) => v === "on"),
  hour: z.coerce
    .number()
    .refine((n) => (DIGEST_HOURS as readonly number[]).includes(n), { message: "Pick a time." }),
  timeZone: z.string().trim().max(64).refine(isTimeZone).catch("America/New_York"),
});

export async function saveDigestSettings(
  workspaceId: string,
  data: z.output<typeof digestSettingsInput>,
  now: Date = new Date(),
) {
  const set = {
    digestEnabled: data.enabled,
    digestHour: data.hour,
    timeZone: data.timeZone,
    updatedAt: now,
  };
  await db()
    .insert(businessProfiles)
    .values({ workspaceId, ...set })
    .onConflictDoUpdate({ target: businessProfiles.workspaceId, set });
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "digest_settings_saved",
      detail: { enabled: data.enabled, hour: data.hour },
    });
}

export async function getVoiceProfile(workspaceId: string): Promise<VoiceProfile | undefined> {
  const [row] = await db()
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.workspaceId, workspaceId));
  return row;
}

const formalityField = z.enum(["casual", "neutral", "formal"]);
export const voiceEditInput = z.object({
  greetingStyle: z.string().trim().min(1, "How do you usually open?").max(100),
  signoffStyle: z.string().trim().min(1, "How do you usually sign off?").max(100),
  formality: formalityField,
  avgLengthWords: z.coerce.number().int().min(10).max(400),
  phrasesUsed: lines(20, 120),
  phrasesAvoided: lines(20, 120),
  summary: z.string().trim().max(600),
});

/** Check 30 P3: a formality stored by newer code is kept when posted back unchanged. */
export function voiceEditInputFor(stored: { formality?: string | null }) {
  return voiceEditInput.extend({ formality: orStored(formalityField, stored.formality) });
}

/** The owner corrected the learned voice. Weekly re-learning won't overwrite this. */
export async function saveVoiceEdits(
  workspaceId: string,
  data: z.output<typeof voiceEditInput>,
  now = new Date(),
) {
  await db()
    .insert(voiceProfiles)
    .values({ workspaceId, ...data, status: "ready", source: "edited", updatedAt: now })
    .onConflictDoUpdate({
      target: voiceProfiles.workspaceId,
      set: { ...data, status: "ready", source: "edited", updatedAt: now },
    });
  await db()
    .insert(activityLog)
    .values({ workspaceId, actor: "owner", action: "voice_profile_edited", detail: {} });
}

/** "You usually open with 'Hey' and sign off 'Thanks, Davi'." — the proof we're paying attention. */
export function describeVoice(
  v: Pick<VoiceProfile, "greetingStyle" | "signoffStyle" | "avgLengthWords" | "formality">,
) {
  const parts: string[] = [];
  if (v.greetingStyle && v.signoffStyle) {
    parts.push(`You usually open with “${v.greetingStyle}” and sign off “${v.signoffStyle}”.`);
  } else if (v.greetingStyle) {
    parts.push(`You usually open with “${v.greetingStyle}”.`);
  } else if (v.signoffStyle) {
    parts.push(`You usually sign off “${v.signoffStyle}”.`);
  }
  if (v.avgLengthWords) {
    const feel =
      v.avgLengthWords <= 60
        ? "short and to the point"
        : v.avgLengthWords <= 150
          ? "a few short paragraphs"
          : "on the longer side";
    parts.push(`Your emails run about ${v.avgLengthWords} words — ${feel}.`);
  }
  if (v.formality) {
    const f = {
      casual: "You keep it casual.",
      neutral: "You're friendly but businesslike.",
      formal: "You keep it formal.",
    } as const;
    if (v.formality in f) parts.push(f[v.formality as keyof typeof f]);
  }
  return parts.join(" ");
}
