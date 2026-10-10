"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { CONTRAST_COOKIE, DEVICE_COOKIE_MAX_AGE, HAND_COOKIE } from "@/lib/device-prefs";
import { requireOwner } from "@/server/session";

const options = {
  path: "/",
  maxAge: DEVICE_COOKIE_MAX_AGE,
  sameSite: "lax" as const,
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
};

/** Plan #9: "I hold my phone in my left hand". This device only. */
export async function saveHandAction(formData: FormData) {
  await requireOwner();
  const left = formData.get("hand") === "left";
  (await cookies()).set(HAND_COOKIE, left ? "left" : "right", options);
  redirect("/settings?done=hand#this-phone");
}
