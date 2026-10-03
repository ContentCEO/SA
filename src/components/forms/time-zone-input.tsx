"use client";

import { useEffect, useState } from "react";

/** Hidden field carrying the browser's time zone, so "7am" means the owner's 7am. */
export function TimeZoneInput({ fallback }: { fallback: string }) {
  const [tz, setTz] = useState(fallback);
  useEffect(() => {
    try {
      const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the browser after mount
      if (detected) setTz(detected);
    } catch {
      // keep the fallback
    }
  }, []);
  return <input type="hidden" name="timeZone" value={tz} />;
}
