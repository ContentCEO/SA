"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { hitLimit, ipKey } from "@/server/rate-limit";
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
  if (!(await hitLimit("waitlist", ipKey(await headers()))).allowed) {
    return {
      status: "error",
      errors: { email: ["Too many tries from here. Try again in an hour, or give us a call."] },
      values: raw,
    };
  }

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
  try {
    await joinWaitlist(parsed.data);
  } catch (err) {
    // A failed query's message carries every bound value, and Next logs whatever an action
    // throws. Log the error's name only and throw a content-free one.
    console.error("waitlist_join_failed", { error: err instanceof Error ? err.name : "unknown" });
    throw new Error("waitlist_join_failed");
  }
  return { status: "joined" };
}
