"use server";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { z } from "zod";
import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { growthInput, requestGrowthCall, sendGrowthEmails } from "@/server/growth";
import { hitLimit, ipKey } from "@/server/rate-limit";
import { sourceFromForm } from "@/server/source-rules";
import { trapWasFilled } from "@/server/trap-rules";
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
 * The call-request form (Squared Away Growth). Public form: validated server-side, the same
 * hashed-IP limit bucket as the app waitlist, and a hidden trap field for bots (Check 2 P3).
 * It never invites anyone to the app.
 */
export async function requestGrowthCallAction(
  _prev: GrowthState,
  formData: FormData,
): Promise<GrowthState> {
  const raw: Record<string, string> = {};
  for (const key of [
    "name",
    "phone",
    "email",
    "trade",
    "note",
    "ref",
    "heardFrom",
    "sentBy",
    "state",
    "timeZone",
  ]) {
    const v = formData.get(key);
    raw[key] = typeof v === "string" ? v : "";
  }
  const services = formData.getAll("services").filter((v): v is string => typeof v === "string");
  const trapFilled = trapWasFilled(formData);
  const values = { ...raw };
  const input = {
    name: raw.name,
    phone: raw.phone,
    email: raw.email,
    trade: raw.trade || null,
    services,
    note: raw.note || null,
    referralCode: raw.ref || null,
    heardFrom: raw.heardFrom || null,
    sentBy: raw.sentBy || null,
    state: raw.state || null,
    timeZone: raw.timeZone || null,
  };
  // Check 2 P3: a filled trap with junk around it is a bot: polite success, nothing stored or
  // counted. A filled trap around a real-looking request (a browser autofilling the field) is
  // stored with a flag and the admin isn't emailed, so no real request can vanish.
  if (trapFilled && !growthInput.safeParse(input).success) {
    console.info("growth_trap_hit", { stored: false });
    return { status: "requested" };
  }
  const h = await headers();
  if (!(await hitLimit("waitlist", ipKey(h))).allowed) {
    return {
      status: "error",
      errors: { phone: [growthCopy.errors.rateLimited] },
      values,
      services,
    };
  }

  const parsed = growthInput.safeParse(input);
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
    await requestGrowthCall(parsed.data, new Date(), source, { trapFilled });
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
  if (trapFilled) {
    console.info("growth_trap_hit", { stored: true });
    return { status: "requested", phone: parsed.data.phone };
  }
  // The admin notice and the visitor's confirmation (Check 2 P2), side by side; never throws.
  await sendGrowthEmails(parsed.data.email);
  return { status: "requested", phone: parsed.data.phone };
}
