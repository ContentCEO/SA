"use server";

import { z } from "zod";
import { joinWaitlist, waitlistInput } from "@/server/waitlist";

export type WaitlistState = {
  status: "idle" | "joined" | "error";
  errors?: Record<string, string[]>;
  values?: Record<string, string>;
};

/**
 * Public form, so: validated server-side, idempotent per email, and a hidden
 * "website" field that people never see — bots that fill it get a polite
 * success and nothing is stored.
 */
export async function joinWaitlistAction(
  _prev: WaitlistState,
  formData: FormData,
): Promise<WaitlistState> {
  const raw = Object.fromEntries(
    [...formData.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]),
  ) as Record<string, string>;
  if (raw.website) return { status: "joined" };

  const parsed = waitlistInput.safeParse({
    name: raw.name ?? "",
    email: raw.email ?? "",
    phone: raw.phone || null,
    trade: raw.trade || null,
    teamSize: raw.teamSize || null,
    note: raw.note || null,
  });
  if (!parsed.success) {
    return {
      status: "error",
      errors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
      values: raw,
    };
  }
  await joinWaitlist(parsed.data);
  return { status: "joined" };
}
