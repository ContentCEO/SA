"use client";

import { useEffect } from "react";
import { saveDetectedTimeZoneAction } from "@/app/(app)/settings/profile-actions";
import type { TimeZoneSource } from "@/db/schema";

/**
 * Check 45 P1: an owner who left setup at step 2 still gets their own clock. While the saved
 * zone was never set (`'default'`), the browser's zone is sent once; the server saves it only
 * if it is real and still unset. Renders nothing.
 */
export function ZoneCapture({ timeZoneSource }: { timeZoneSource: TimeZoneSource }) {
  useEffect(() => {
    if (timeZoneSource !== "default") return;
    let tz: string | undefined;
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      return;
    }
    if (tz) void saveDetectedTimeZoneAction(tz).catch(() => {});
  }, [timeZoneSource]);
  return null;
}
