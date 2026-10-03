import "server-only";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  activityLog,
  businessProfiles,
  voiceProfiles,
  workspaces,
  type BusinessProfile,
  type VoiceProfile,
} from "@/db/schema";

const TRADES = ["carpentry", "plumbing", "electrical", "other"] as const;

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

export const businessProfileInput = z.object({
  businessName: z.string().trim().min(1, "What's the business called?").max(120),
  trade: z.enum(TRADES, { message: "Pick your trade." }),
  services: z.string().trim().min(1, "Tell us what work you do.").max(2000),
  serviceArea: longText(),
  hours: longText(500),
  leadTime: longText(500),
  pricingNotes: longText(),
  paymentTerms: longText(1000),
  policies: longText(),
  signature: longText(500),
  doNotPromise: lines(30),
  vipSenders: lines(50, 254).pipe(
    z.array(z.string().toLowerCase().email("Each VIP line should be one email address.")),
  ),
  amountThresholdDollars: z.coerce
    .number({ message: "Enter a dollar amount." })
    .int("Whole dollars, please.")
    .min(0)
    .max(10_000_000),
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
  const { businessName, trade, ...profile } = data;
  await db().update(workspaces).set({ businessName, trade }).where(eq(workspaces.id, workspaceId));
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

export async function getVoiceProfile(workspaceId: string): Promise<VoiceProfile | undefined> {
  const [row] = await db()
    .select()
    .from(voiceProfiles)
    .where(eq(voiceProfiles.workspaceId, workspaceId));
  return row;
}

export const voiceEditInput = z.object({
  greetingStyle: z.string().trim().min(1, "How do you usually open?").max(100),
  signoffStyle: z.string().trim().min(1, "How do you usually sign off?").max(100),
  formality: z.enum(["casual", "neutral", "formal"]),
  avgLengthWords: z.coerce.number().int().min(10).max(400),
  phrasesUsed: lines(20, 120),
  phrasesAvoided: lines(20, 120),
  summary: z.string().trim().max(600),
});

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
