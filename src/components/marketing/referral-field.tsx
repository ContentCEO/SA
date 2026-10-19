"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { isReferralCode } from "@/lib/referral-code";

/**
 * Plan #47 / Check 29 P3: a referral link's code (?ref=), read here in the browser so the
 * homepage can be prerendered. Rendered only while referrals are switched on (the server page
 * decides); the server action checks the code again (and the switch) before keeping it.
 * `kept` is the code a failed submit posted, which wins over the address bar.
 */
function ReferralCodeInput({ kept }: { kept?: string }) {
  const code = useSearchParams().get("ref");
  const value = kept ?? code;
  return isReferralCode(value) ? <input type="hidden" name="ref" defaultValue={value} /> : null;
}

export function ReferralField({ kept }: { kept?: string }) {
  return (
    // useSearchParams needs a Suspense boundary on a prerendered page.
    <Suspense fallback={null}>
      <ReferralCodeInput kept={kept} />
    </Suspense>
  );
}
