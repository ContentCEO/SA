"use server";

import { headers } from "next/headers";
import { unstable_rethrow } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { siteConfig } from "@/config/site";
import { ownHosts } from "@/server/own-hosts";
import { hitLimit, ipKey } from "@/server/rate-limit";
import { sourceFromForm } from "@/server/source-rules";
import { TRAP_FIELD, trapWasFilled } from "@/server/trap-rules";
import { joinWaitlist, waitlistInput } from "@/server/waitlist";
import { addressKey } from "@/server/growth";
import { sendWaitlistEmails } from "@/server/waitlist-emails";

export type WaitlistState = {
  status: "idle" | "joined" | "error";
  errors?: Record<string, string[]>;
  values?: Record<string, string>;
};

const EMAIL_LIMITED = `Too many tries for this email today. Try again tomorrow, or call or text ${siteConfig.phone}.`;
const SAVE_FAILED = `We couldn't save that just now. Try again in a minute, or call or text ${siteConfig.phone}.`;

/**
 * Public form, so: validated server-side, idempotent per email, and a hidden
 * trap field that people never see (Check 2 P3: bots that fill it with junk get a polite
 * success and nothing is stored; a real-looking sign-up with it filled is kept, flagged).
 */
export async function joinWaitlistAction(
  _prev: WaitlistState,
  formData: FormData,
): Promise<WaitlistState> {
  const raw = Object.fromEntries(
    [...formData.entries()].map(([k, v]) => [k, typeof v === "string" ? v : ""]),
  ) as Record<string, string>;
  delete raw.website;
  delete raw[TRAP_FIELD];
  const trapFilled = trapWasFilled(formData);
  const input = {
    name: raw.name ?? "",
    email: raw.email ?? "",
    phone: raw.phone || null,
    trade: raw.trade || null,
    teamSize: raw.teamSize || null,
    note: raw.note || null,
    referralCode: raw.ref || null,
  };
  // Check 2 P3: trap + junk = a bot (polite success, nothing stored or counted); trap + a
  // real-looking sign-up is kept with a flag in the note and nobody is emailed.
  if (trapFilled && !waitlistInput.safeParse(input).success) {
    console.info("waitlist_trap_hit", { stored: false });
    return { status: "joined" };
  }
  const h = await headers();
  if (!(await hitLimit("waitlist", ipKey(h))).allowed) {
    return {
      status: "error",
      // Check 6 P10: a form-wide message, so it doesn't read as if the email were wrong.
      errors: { form: ["Too many tries from here. Try again in an hour, or give us a call."] },
      values: raw,
    };
  }

  const parsed = waitlistInput.safeParse(input);
  if (!parsed.success) {
    return {
      status: "error",
      errors: z.flattenError(parsed.error).fieldErrors as Record<string, string[]>,
      values: raw,
    };
  }
  // Check 26 P8: at most 5 sign-ups a day for one email address, from anywhere.
  if (!(await hitLimit("formEmail", addressKey(parsed.data.email))).allowed) {
    return { status: "error", errors: { form: [EMAIL_LIMITED] }, values: raw };
  }
  const source = sourceFromForm((k) => formData.get(k), ownHosts(h));
  let result: Awaited<ReturnType<typeof joinWaitlist>>;
  try {
    result = await joinWaitlist(parsed.data, source, { trapFilled });
  } catch (err) {
    unstable_rethrow(err);
    // A failed query's message carries every bound value: log the error's name only, and keep
    // what they typed on screen with a plain message instead of an error page.
    console.error("waitlist_join_failed", { error: err instanceof Error ? err.name : "unknown" });
    return { status: "error", errors: { form: [SAVE_FAILED] }, values: raw };
  }
  if (trapFilled) console.info("waitlist_trap_hit", { stored: result === "joined" });
  if (result === "joined" && !trapFilled) {
    // After the response: the visitor never waits on Resend, and a failed email never fails
    // the sign-up (sendWaitlistEmails never throws).
    const email = parsed.data.email;
    after(() => sendWaitlistEmails(email));
  }
  return { status: "joined" };
}
