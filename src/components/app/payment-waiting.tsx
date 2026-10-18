"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/**
 * Check 17 P9: after paying, re-check the page a bounded number of times while Stripe's notice
 * arrives; after the last one, say plainly what happens next instead of "updates by itself"
 * forever, and tell Davi once (the server action records it; only the webhook changes status).
 */
export function PaymentWaiting({
  everyMs = 3000,
  times = 10,
  giveUpText,
  phone,
  phoneHref,
  onGiveUp,
}: {
  everyMs?: number;
  times?: number;
  giveUpText: string;
  phone: string;
  phoneHref: string;
  onGiveUp: () => Promise<void>;
}) {
  const router = useRouter();
  const [gaveUp, setGaveUp] = useState(false);
  const told = useRef(false);
  // Each refresh hands a new function; the counter must not restart because of it.
  const giveUp = useRef(onGiveUp);
  useEffect(() => {
    giveUp.current = onGiveUp;
  }, [onGiveUp]);
  useEffect(() => {
    let n = 0;
    const t = setInterval(() => {
      if (++n > times) {
        clearInterval(t);
        setGaveUp(true);
        if (!told.current) {
          told.current = true;
          void giveUp.current().catch(() => {});
        }
        return;
      }
      router.refresh();
    }, everyMs);
    return () => clearInterval(t);
  }, [router, everyMs, times]);

  if (gaveUp) {
    return (
      <>
        <p className="text-lg font-black">{giveUpText}</p>
        <a
          href={phoneHref}
          className="inline-flex min-h-tap items-center self-start font-semibold underline underline-offset-4"
        >
          {phone}
        </a>
      </>
    );
  }
  return (
    <>
      <p className="text-lg font-black">Payment received — finishing up.</p>
      <p className="text-ash">This takes a few seconds. The page updates by itself.</p>
    </>
  );
}
