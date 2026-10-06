"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
type Mode = "loading" | "installed" | "prompt" | "ios" | "other";

/**
 * "Get the app": Android/Chrome get a real Install button; iPhone gets the two
 * taps it needs (Share, then Add to Home Screen); already-installed says so.
 */
export function GetTheApp() {
  const [mode, setMode] = useState<Mode>("loading");
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the browser after mount
    setMode(standalone ? "installed" : ios ? "ios" : "other");
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setPrompt(e as InstallPrompt);
      setMode("prompt");
    };
    const onInstalled = () => setMode("installed");
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (mode === "loading") return null;
  if (mode === "installed") {
    return <p className="text-lg">You&apos;re using the app. It updates itself — nothing to do.</p>;
  }
  if (mode === "prompt" && prompt) {
    return (
      <Button
        type="button"
        size="lg"
        className="w-full"
        onClick={async () => {
          await prompt.prompt();
          const { outcome } = await prompt.userChoice;
          if (outcome === "accepted") setMode("installed");
        }}
      >
        Install Squared Away
      </Button>
    );
  }
  if (mode === "ios") {
    return (
      <ol className="flex list-decimal flex-col gap-1 pl-6 text-lg">
        <li>
          Tap the <span className="font-semibold">Share</span> button at the bottom of Safari.
        </li>
        <li>
          Tap <span className="font-semibold">Add to Home Screen</span>, then{" "}
          <span className="font-semibold">Add</span>.
        </li>
      </ol>
    );
  }
  return (
    <p className="text-lg">
      Open this page on your phone, then use your browser&apos;s{" "}
      <span className="font-semibold">Install app</span> or{" "}
      <span className="font-semibold">Add to Home Screen</span> option.
    </p>
  );
}
