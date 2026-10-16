"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Every section id the one-page Settings had; old links and bookmarks may carry any of them. */
export const LEGACY_SETTINGS_IDS = [
  "mailbox",
  "business",
  "voice",
  "followups",
  "app-heading",
  "this-phone",
  "never-say",
  "seasonal-notes",
  "digest",
  "texts",
  "autopilot",
  "account",
] as const;

/** The screen that now holds an old section ("#digest" → the morning email screen). */
export function legacySettingsScreen(hash: string) {
  switch (hash.replace(/^#/, "")) {
    case "mailbox":
      return "/settings/gmail";
    case "business":
    case "seasonal-notes":
      return "/settings/business";
    case "voice":
    case "never-say":
      return "/settings/writing";
    case "followups":
      return "/settings/follow-ups";
    case "app-heading":
    case "this-phone":
      return "/settings/phone";
    case "digest":
      return "/settings/morning-email";
    case "texts":
      return "/settings/texts";
    case "autopilot":
      return "/settings/autopilot";
    case "account":
      return "/settings/account";
    default:
      return "/settings";
  }
}

/**
 * Settings used to be one long page with sections (`/settings#digest` from the morning email).
 * A link to an old section opens the screen that holds it now. Only our own fixed paths.
 */
export function LegacySettingsAnchors() {
  const router = useRouter();
  useEffect(() => {
    const to = legacySettingsScreen(window.location.hash);
    if (to !== "/settings") router.replace(to);
  }, [router]);
  return null;
}
