"use server";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { growthInput, notifyGrowthRequest, requestGrowthCall } from "@/server/growth";
import { hitLimit, ipKey } from "@/server/rate-limit";
import { sourceFromForm } from "@/server/source-rules";
import { ownHosts } from "@/server/own-hosts";

export type GrowthState = {
  status: "idle" | "requested" | "error";
  /** The number they gave, tidied ("617-555-0142"), for the thank-you line. */
  phone?: string;
  errors?: Record<string, string[]>;
  values?: Record<string, string>;
  services?: string[];
};

/**
 * "Book a free call" (Squared Away Growth). Public form: validated server-side, the same
 * hashed-IP limit bucket as the app waitlist, and the hidden "website" field for bots.
 * It never invites anyone to the app.
 */
export async function requestGrowthCallAction(
  _prev: GrowthState,
  formData: FormData,
): Promise<GrowthState> {
  const raw: Record<string, string> = {};
  for (const key of ["name", "phone", "email", "trade", "note", "website"]) {
    const v = formData.get(key);
    raw[key] = typeof v === "string" ? v : "";
  }
  const services = formData.getAll("services").filter((v): v is string => typeof v === "string");
  if (raw.website) return { status: "requested" };

  const values = Object.fromEntries(Object.entries(raw).filter(([k]) => k !== "website"));
  const h = await headers();
  if (!(await hitLimit("waitlist", ipKey(h))).allowed) {
    return {
      status: "error",
      errors: { phone: [growthCopy.errors.rateLimited] },
      values,
      services,
    };
  }

  const parsed = growthInput.safeParse({
    name: raw.name,
    phone: raw.phone,
    email: raw.email,
    trade: raw.trade || null,
    services,
    note: raw.note || null,
  });
  if (!parsed.success) {
    return {
      status: "error",
      errors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
      values,
      services,
    };
  }

  const source = sourceFromForm((k) => formData.get(k), ownHosts(h));
  try {
    await requestGrowthCall(parsed.data, new Date(), source);
  } catch (err) {
    unstable_rethrow(err);
    // A failed query's message carries every bound value (name, phone, email, note): log the
    // error's name only, and keep what they typed on screen with a plain message.
    console.error("growth_request_failed", {
      error: err instanceof Error ? err.name : "unknown",
    });
    return {
      status: "error",
      errors: { form: [growthCopy.errors.saveFailed] },
      values,
      services,
    };
  }
  try {
    await notifyGrowthRequest(parsed.data.email);
  } catch (err) {
    console.warn("growth_notify_failed", { error: err instanceof Error ? err.name : "unknown" });
  }
  return { status: "requested", phone: parsed.data.phone };
}
