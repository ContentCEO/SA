"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { removePushAction, savePushAction } from "@/app/(app)/settings/device-actions";

type State = "loading" | "unsupported" | "blocked" | "off" | "on" | "working";

const toKey = (b64url: string) => {
  const s = atob(
    b64url
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(Math.ceil(b64url.length / 4) * 4, "="),
  );
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

/**
 * Plan #36: turn phone notifications on or off for this phone. The note says
 * exactly what they contain, because it's true: counts, never names or words.
 */
export function PushToggle({ publicKey }: { publicKey: string }) {
  const [state, setState] = useState<State>("loading");
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
      if (Notification.permission === "denied") return "blocked";
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      return sub ? "on" : "off";
    })()
      .then((s) => live && setState(s as State))
      .catch(() => live && setState("unsupported"));
    return () => {
      live = false;
    };
  }, []);

  const turnOn = async () => {
    setState("working");
    setNote(null);
    try {
      if ((await Notification.requestPermission()) !== "granted") return setState("blocked");
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: toKey(publicKey),
      });
      const ok = await savePushAction(sub.endpoint);
      if (!ok) {
        await sub.unsubscribe();
        setNote("This browser's notifications aren't supported. Try Chrome or Safari.");
        return setState("off");
      }
      setState("on");
    } catch {
      setNote(
        "Couldn't turn them on. If you're on an iPhone, add the app to your home screen first.",
      );
      setState("off");
    }
  };

  const turnOff = async () => {
    setState("working");
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await removePushAction(sub.endpoint);
      await sub.unsubscribe();
    }
    setState("off");
  };

  if (state === "loading") return null;
  if (state === "unsupported")
    return (
      <p className="text-muted-foreground">
        This browser can&apos;t show notifications. On an iPhone, add the app to your home screen
        first, then turn them on from there.
      </p>
    );
  if (state === "blocked")
    return (
      <p className="text-muted-foreground">
        Notifications are blocked for this site. Allow them in your phone&apos;s settings, then come
        back here.
      </p>
    );
  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={state === "working"}
        aria-pressed={state === "on"}
        onClick={state === "on" ? turnOff : turnOn}
      >
        {state === "on" ? "Turn off notifications on this phone" : "Turn on notifications"}
      </Button>
      <p className="text-sm text-muted-foreground">
        {state === "on" ? "On. " : ""}A buzz when a quote request or an email that needs you comes
        in — like “2 emails need you”. Never a name or what they wrote. Quiet 9pm–7am.
      </p>
      {note ? (
        <p role="status" className="text-sm font-semibold">
          {note}
        </p>
      ) : null}
    </div>
  );
}
