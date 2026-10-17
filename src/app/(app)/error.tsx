"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { Headline } from "@/components/brand/headline";
import { Button } from "@/components/ui/button";

const subscribe = (onChange: () => void) => {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
};

/**
 * Check 8 P1: an error inside the signed-in app keeps the header and the tab bar (this boundary
 * sits inside the (app) layout). When the phone couldn't reach us (offline, or the request
 * itself failed), it says so and how to tell whether a reply went; otherwise the usual words.
 * Never the error's message or digest.
 */
export default function AppError({
  error,
  retry,
}: {
  error: Error & { digest?: string };
  retry: () => void;
}) {
  const online = useSyncExternalStore(
    subscribe,
    () => navigator.onLine,
    () => true,
  );
  const unreachable = !online || error?.name === "TypeError";
  return (
    <div className="flex flex-col gap-6">
      {unreachable ? (
        <>
          <Headline serif="no connection," heavy="check the queue." />
          <p className="text-lg">
            We couldn&apos;t reach Squared Away. If this was a reply, open the Queue when you have
            signal: if the card is still there, it wasn&apos;t sent.
          </p>
        </>
      ) : (
        <>
          <Headline serif="sorry about that," heavy="something broke." />
          <p className="text-lg">Something went wrong on our side.</p>
        </>
      )}
      <div className="flex flex-col gap-3 sm:flex-row">
        <Button type="button" size="lg" onClick={() => retry()}>
          Try again
        </Button>
        <Link
          href="/queue"
          className="inline-flex min-h-tap items-center justify-center rounded-lg border-2 border-charcoal px-5 font-semibold"
        >
          Open the Queue
        </Link>
      </div>
    </div>
  );
}
