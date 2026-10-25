"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { isTimeZone, sameClock, zoneTimeName } from "@/server/time-zone-rules";
import { takePhoneZoneAction } from "../profile-actions";

/**
 * Check 44 P5 / 15 P7: when this phone's clock isn't the saved zone, say so and offer it.
 * Nothing changes until the owner taps the button (a phone on holiday never moves the zone).
 */
export function PhoneZoneOffer({ saved }: { saved: string }) {
  const [phone, setPhone] = useState<string | null>(null);
  useEffect(() => {
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the browser after mount
      if (isTimeZone(tz) && !sameClock(tz, saved)) setPhone(tz);
    } catch {
      // no zone from this browser: nothing to offer
    }
  }, [saved]);
  if (!phone) return null;
  const name = zoneTimeName(phone);
  return (
    <form action={takePhoneZoneAction} className="flex flex-col gap-2">
      <input type="hidden" name="timeZone" value={phone} />
      <p className="font-semibold">This phone is on {name}.</p>
      <Button type="submit" variant="outline" className="w-full">
        Use {name}
      </Button>
    </form>
  );
}
