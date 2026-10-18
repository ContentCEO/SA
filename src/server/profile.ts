import "server-only";
import { and, eq, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { LICENSE_FIELD_MAX, type Licenses } from "@/config/licenses";
import { cleanExtraTrades, MAX_EXTRA_TRADES, TRADES } from "@/config/trades";
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
import { isTimeZone } from "./time-zone-rules";
import { BIG_QUOTE_DAY_CHOICES } from "./followup-rules";

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
    .string({ message: "Type one per line." })
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
 * each an email, lowercased, de-duplicated after lowercasing, at most 30. Settings → Your
 * business ("Your crew's email addresses"), Check 22 P10 + 41 P6.
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

/** What a VIP line looks like in an error: trimmed, one line, short. Never logged. */
function shownLine(text: string) {
  const one = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return one.length > 60 ? `${one.slice(0, 59)}…` : one;
}

const emailAddress = z.email();
export const MAX_VIP_SENDERS = 50;

/**
 * Check 15 P2: "People who always need you", one address per line — or pasted the way Gmail
 * copies them: "Sue Smith <sue@example.com>", or several on a line split by commas or
 * semicolons. Lowercased and de-duplicated. A line that still isn't an address is named.
 */
export const vipSenders = z
  .string({ message: "Type one email address per line." })
  .transform((v, ctx) => {
    const out: string[] = [];
    for (const line of v.split("\n")) {
      if (!line.trim()) continue;
      const bracketed = [...line.matchAll(/<([^<>]*)>/g)].map((m) => m[1]!);
      const parts = bracketed.length ? bracketed : line.split(/[,;]/);
      for (const part of parts) {
        const addr = part.trim().toLowerCase();
        if (!addr) continue;
        if (addr.length > 254 || !emailAddress.safeParse(addr).success) {
          ctx.addIssue({
            code: "custom",
            message: `This line isn't an email address: “${shownLine(bracketed.length ? line : part)}”.`,
          });
          continue;
        }
        out.push(addr);
      }
    }
    return [...new Set(out)];
  })
  .pipe(z.array(z.string()).max(MAX_VIP_SENDERS, `Up to ${MAX_VIP_SENDERS} addresses.`));

export const AMOUNT_BLANK_MESSAGE =
  "Type a dollar amount, like 2,500. Leaving it blank would send you every email with a price in it.";
export const AMOUNT_MESSAGE = "Type a dollar amount, like 2,500.";
export const AMOUNT_WHOLE_MESSAGE = "Whole dollars, please.";
export const AMOUNT_TOO_BIG_MESSAGE = "That's more than we can check. Try a smaller amount.";
export const MAX_AMOUNT_THRESHOLD_DOLLARS = 10_000_000;

/**
 * Check 15 P1: "Send me anything that mentions more than". Typed the way people write money
 * ("2,500", "$2,500"); a blank box is refused, never saved as $0 (which would send the owner
 * every email with a price in it and stop every automatic draft for them).
 */
export const amountThresholdDollars = z.unknown().transform((v, ctx) => {
  const typed = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
  const t = typed.trim().replace(/^\$\s*/, "");
  const fail = (message: string) => {
    ctx.addIssue({ code: "custom", message });
    return z.NEVER;
  };
  if (t === "") return fail(AMOUNT_BLANK_MESSAGE);
  // Commas only as thousands separators: "2,500" and "1,250,000", never "25,00".
  const plain = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t) ? t.replace(/,/g, "") : t;
  if (!/^-?\d+(\.\d+)?$/.test(plain)) return fail(AMOUNT_MESSAGE);
  const n = Number(plain);
  if (n < 0) return fail(AMOUNT_MESSAGE);
  if (!Number.isInteger(n)) return fail(AMOUNT_WHOLE_MESSAGE);
  if (n > MAX_AMOUNT_THRESHOLD_DOLLARS) return fail(AMOUNT_TOO_BIG_MESSAGE);
  return n;
});

export const businessProfileInput = z.object({
  businessName: z
    .string({ message: "What's the business called?" })
    .trim()
    .min(1, "What's the business called?")
    .max(120, "Keep the name under 120 characters."),
  trade: z.enum(TRADES, { message: "Pick your trade." }),
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
  services: z
    .string({ message: "Tell us what work you do." })
    .trim()
    .min(1, "Tell us what work you do.")
    .max(2000, "Keep this under 2,000 characters."),
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
  vipSenders,
  /** Check 22 P10 + 41 P6: the owner's crew. Left out entirely = leave the list as it is. */
  crewAddresses: crewAddressesSchema.optional(),
  /**
   * Check 38 P2: "Which state do you work in?" — two letters, '' = not set. Left out = leave it.
   * Massachusetts turns on the one-third deposit warning.
   */
  state: z
    .string()
    .trim()
    .toUpperCase()
    .refine(
      (v) => v === "" || (US_STATE_CODES as readonly string[]).includes(v),
      "Pick your state from the list.",
    )
    .transform((v) => (v === "" ? null : v))
    .optional(),
  // Check 38 P6: "Licenses and registrations".
  hicNumber: licenseLine,
  hicExpiresOn: licenseDate,
  cslNumber: licenseLine,
  leadSafeLicense: licenseLine,
  insuranceCarrier: licenseLine,
  amountThresholdDollars,
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
  const profile = { ...rest, ...(licenses ? { licenses } : {}) };
  // Check 41 P6: a changed crew list is logged with its size only, never the addresses.
  const crewBefore =
    rest.crewAddresses === undefined
      ? undefined
      : ((await getBusinessProfile(workspaceId))?.crewAddresses ?? []);
  await db()
    .update(workspaces)
    .set({
      businessName,
      trade,
      ...(extraTrades ? { extraTrades: cleanExtraTrades(extraTrades, trade) } : {}),
    })
    .where(eq(workspaces.id, workspaceId));
  await db()
    .insert(businessProfiles)
    .values({ workspaceId, ...profile, completedAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: businessProfiles.workspaceId,
      // Check 45 P1: the row often exists before setup (the first page load saves the browser's
      // zone), so the first save marks the profile done here too, and later saves keep that date.
      set: {
        ...profile,
        completedAt: sql`coalesce(${businessProfiles.completedAt}, ${now.toISOString()}::timestamptz)`,
        updatedAt: now,
      },
    });
  // Check 45 P1: setup's browser zone, unless the owner picked one on purpose.
  if (timeZone)
    await db()
      .update(businessProfiles)
      .set({ timeZone, timeZoneSource: "browser" })
      .where(
        and(
          eq(businessProfiles.workspaceId, workspaceId),
          ne(businessProfiles.timeZoneSource, "owner"),
        ),
      );
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "business_profile_saved",
    detail: {},
  });
  if (
    rest.crewAddresses !== undefined &&
    crewBefore !== undefined &&
    [...crewBefore].sort().join("\n") !== [...rest.crewAddresses].sort().join("\n")
  ) {
    await db()
      .insert(activityLog)
      .values({
        workspaceId,
        actor: "owner",
        action: "crew_list_saved",
        detail: { count: rest.crewAddresses.length },
      });
  }
}

// Check 38 P4: 10 and 14 for bigger jobs that take longer to decide.
export const FOLLOWUP_DAY_CHOICES = [2, 3, 4, 5, 7, 10, 14] as const;
export { BIG_QUOTE_DAY_CHOICES } from "./followup-rules";

export const followupSettingsInput = z.object({
  enabled: z
    .literal("on", { message: "Tick the box or leave it empty." })
    .optional()
    .transform((v) => v === "on"),
  days: z.coerce
    .number({ message: "Pick how many days to wait." })
    .refine((n) => (FOLLOWUP_DAY_CHOICES as readonly number[]).includes(n), {
      message: "Pick how many days to wait.",
    }),
  // Check 38 P4: empty (or missing) = the same as the normal wait.
  bigQuoteDays: z.preprocess(
    (v) => (v === "" || v == null ? null : Number(v)),
    z
      .number()
      .refine((n) => (BIG_QUOTE_DAY_CHOICES as readonly number[]).includes(n), {
        message: "Pick how many days to wait for big quotes.",
      })
      .nullable(),
  ),
});

/** Follow-up settings live on the business profile row; create it if needed. */
export async function saveFollowupSettings(
  workspaceId: string,
  data: z.output<typeof followupSettingsInput>,
  now: Date = new Date(),
) {
  const set = {
    followupsEnabled: data.enabled,
    followupDays: data.days,
    bigQuoteDays: data.bigQuoteDays,
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
      action: "followup_settings_saved",
      detail: { enabled: data.enabled, days: data.days, bigQuoteDays: data.bigQuoteDays },
    });
}

export const WORK_DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

/**
 * Check 15 P8: "Your working days (for alerts)": ticked ISO weekdays (1 = Monday), and the
 * local hour the day starts and ends (end exclusive, 24 = midnight).
 */
export const workHoursInput = z
  .object({
    days: z
      .array(z.coerce.number({ message: "Pick your days from the list." }).int().min(1).max(7), {
        message: "Pick your days from the list.",
      })
      .min(1, "Pick at least one day.")
      .transform((d) => [...new Set(d)].sort((a, b) => a - b)),
    startHour: z.coerce
      .number({ message: "Pick when your day starts." })
      .int("Pick when your day starts.")
      .min(0, "Pick when your day starts.")
      .max(23, "Pick when your day starts."),
    endHour: z.coerce
      .number({ message: "Pick when your day ends." })
      .int("Pick when your day ends.")
      .min(1, "Pick when your day ends.")
      .max(24, "Pick when your day ends."),
  })
  .refine((v) => v.startHour < v.endHour, {
    message: "Your day has to end after it starts.",
    path: ["endHour"],
  });

export async function saveWorkHours(
  workspaceId: string,
  data: z.output<typeof workHoursInput>,
  now: Date = new Date(),
) {
  const set = {
    workDays: data.days,
    workStartHour: data.startHour,
    workEndHour: data.endHour,
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
      action: "work_hours_saved",
      detail: { days: data.days.length },
    });
}

/**
 * Check 43 P8: "Languages you answer customers in". English is always on; Spanish and
 * Portuguese are switches. Anything else posted is ignored.
 */
export const replyLanguagesInput = z
  .array(z.string())
  .transform((list) => ["en", ...OPTIONAL_REPLY_LANGUAGES.filter((l) => list.includes(l))]);
export const OPTIONAL_REPLY_LANGUAGES = ["es", "pt"] as const;

export async function saveReplyLanguages(
  workspaceId: string,
  languages: z.output<typeof replyLanguagesInput>,
  now: Date = new Date(),
) {
  const set = { replyLanguages: languages, updatedAt: now };
  await db()
    .insert(businessProfiles)
    .values({ workspaceId, ...set })
    .onConflictDoUpdate({ target: businessProfiles.workspaceId, set });
  await db().insert(activityLog).values({
    workspaceId,
    actor: "owner",
    action: "reply_languages_saved",
    detail: { languages },
  });
}

export const DIGEST_HOURS = [5, 6, 7, 8, 9] as const;

export const digestSettingsInput = z.object({
  enabled: z
    .literal("on", { message: "Tick the box or leave it empty." })
    .optional()
    .transform((v) => v === "on"),
  hour: z.coerce
    .number({ message: "Pick a time." })
    .refine((n) => (DIGEST_HOURS as readonly number[]).includes(n), { message: "Pick a time." }),
  /**
   * Check 44 P5 / 15 P7: the visible "Your time zone" select. Left out = keep the saved zone
   * (a browser's zone is never posted from this screen any more).
   */
  timeZone: z
    .string({ message: "Pick your time zone." })
    .trim()
    .refine(isTimeZone, "Pick your time zone.")
    .optional(),
});

export async function saveDigestSettings(
  workspaceId: string,
  data: z.output<typeof digestSettingsInput>,
  now: Date = new Date(),
) {
  // The time zone is saved apart (setOwnerTimeZone), only when the owner changed it.
  const set = { digestEnabled: data.enabled, digestHour: data.hour, updatedAt: now };
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

/**
 * Check 44 P5 / 15 P7: the owner picked a zone (the select, or "Use Central time"). Saved with
 * source 'owner' so no browser replaces it. Logs the old and new zone names only.
 * Returns false when the zone is not real or is already the saved one.
 */
export async function setOwnerTimeZone(workspaceId: string, timeZone: string, now = new Date()) {
  if (!isTimeZone(timeZone)) return false;
  const [current] = await db()
    .select({ timeZone: businessProfiles.timeZone, source: businessProfiles.timeZoneSource })
    .from(businessProfiles)
    .where(eq(businessProfiles.workspaceId, workspaceId));
  if (current?.timeZone === timeZone) {
    if (current.source !== "owner")
      await db()
        .update(businessProfiles)
        .set({ timeZoneSource: "owner" })
        .where(eq(businessProfiles.workspaceId, workspaceId));
    return false;
  }
  const set = { timeZone, timeZoneSource: "owner" as const, updatedAt: now };
  await db()
    .insert(businessProfiles)
    .values({ workspaceId, ...set })
    .onConflictDoUpdate({ target: businessProfiles.workspaceId, set });
  await db()
    .insert(activityLog)
    .values({
      workspaceId,
      actor: "owner",
      action: "time_zone_changed",
      detail: { from: current?.timeZone ?? null, to: timeZone },
    });
  return true;
}

/**
 * Check 45 P1: the browser's zone from the first signed-in page load, only while the zone was
 * never set (source 'default'). Returns true when it saved. No content in the log row.
 */
export async function saveDetectedTimeZone(
  workspaceId: string,
  timeZone: unknown,
  now = new Date(),
) {
  if (!isTimeZone(timeZone)) return false;
  const set = { timeZone, timeZoneSource: "browser" as const, updatedAt: now };
  const inserted = await db()
    .insert(businessProfiles)
    .values({ workspaceId, ...set })
    .onConflictDoNothing({ target: businessProfiles.workspaceId })
    .returning({ id: businessProfiles.workspaceId });
  const saved = inserted.length
    ? inserted
    : await db()
        .update(businessProfiles)
        .set(set)
        .where(
          and(
            eq(businessProfiles.workspaceId, workspaceId),
            eq(businessProfiles.timeZoneSource, "default"),
          ),
        )
        .returning({ id: businessProfiles.workspaceId });
  if (!saved.length) return false;
  await db()
    .insert(activityLog)
    .values({ workspaceId, actor: "squared_away", action: "time_zone_detected", detail: {} });
  return true;
}

export async function getVoiceProfile(workspaceId: string): Promise<VoiceProfile | undefined> {
  const [row] = await db()
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.workspaceId, workspaceId));
  return row;
}

/** Check 24 P11: an empty box (or "I don't use one") saves null: no greeting / no sign-off. */
const optionalStyle = z
  .string({ message: "Keep this under 100 characters." })
  .trim()
  .max(100, "Keep this under 100 characters.")
  .optional()
  .transform((v) => (v ? v : null));
const ticked = z
  .literal("on", { message: "Tick the box or leave it empty." })
  .optional()
  .transform((v) => v === "on");

const voiceFields = z.object({
  greetingStyle: optionalStyle,
  noGreeting: ticked,
  signoffStyle: optionalStyle,
  noSignoff: ticked,
  formality: z.enum(["casual", "neutral", "formal"], { message: "Pick how formal you are." }),
  // Check 15 P2: a blank box is "type a number", not "at least 10".
  avgLengthWords: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.coerce
      .number({ message: "Type a number of words, like 60." })
      .int("A whole number, like 60.")
      .min(10, "At least 10 words.")
      .max(400, "Up to 400 words."),
  ),
  phrasesUsed: lines(20, 120),
  phrasesAvoided: lines(20, 120),
  summary: z
    .string({ message: "Keep this under 600 characters." })
    .trim()
    .max(600, "Keep this under 600 characters."),
});

export const voiceEditInput = voiceFields.transform(({ noGreeting, noSignoff, ...v }) => ({
  ...v,
  greetingStyle: noGreeting ? null : v.greetingStyle,
  signoffStyle: noSignoff ? null : v.signoffStyle,
}));

/** The owner corrected the learned voice. Weekly re-learning won't overwrite this. */
export async function saveVoiceEdits(
  workspaceId: string,
  data: z.output<typeof voiceEditInput>,
  now = new Date(),
) {
  // Check 24 P8: a changed greeting, sign-off, formality or length makes the stored sample
  // replies stale (drafts then get none until new ones are written). Decided in SQL against the
  // stored row, so it can't race a learn.
  const changed = sql`(${voiceProfiles.greetingStyle} is distinct from ${data.greetingStyle}
    or ${voiceProfiles.signoffStyle} is distinct from ${data.signoffStyle}
    or ${voiceProfiles.formality} is distinct from ${data.formality}
    or ${voiceProfiles.avgLengthWords} is distinct from ${data.avgLengthWords}::integer)`;
  await db()
    .insert(voiceProfiles)
    .values({ workspaceId, ...data, status: "ready", source: "edited", updatedAt: now })
    .onConflictDoUpdate({
      target: voiceProfiles.workspaceId,
      set: {
        ...data,
        status: "ready",
        source: "edited",
        updatedAt: now,
        examplesStale: sql`${voiceProfiles.examplesStale} or ${changed}`,
      },
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
  } else {
    // Check 24 P11: no greeting or no sign-off is a way of writing, so it's said.
    parts.push(
      v.greetingStyle
        ? `You usually open with “${v.greetingStyle}”.`
        : "You usually jump straight in.",
    );
    parts.push(
      v.signoffStyle ? `You usually sign off “${v.signoffStyle}”.` : "You don't sign off.",
    );
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
