"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { INSTALL_BOLD, installSteps } from "@/lib/install-steps";

type InstallPrompt = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
type Mode = "loading" | "installed" | "prompt" | "steps";

/** One step, with the words to look for on screen in bold. */
function Step({ text }: { text: string }) {
  return (
    <li>
      {text.split(INSTALL_BOLD).map((part, i) =>
        i % 2 === 1 ? (
          <span key={i} className="font-semibold">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </li>
  );
}

/**
 * "Get the app": wherever the browser offers its own install prompt (Chrome and Edge on
 * Android or a computer) a real Install button; otherwise the steps for the browser in the
 * owner's hand (src/lib/install-steps.ts — iPhone Safari on iOS 26, Chrome / Edge / Firefox on
 * iPhone, iPad, Android, a computer); already-installed says so.
 */
export function GetTheApp() {
  const [mode, setMode] = useState<Mode>("loading");
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [steps, setSteps] = useState<string[]>([]);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from the browser after mount
    setSteps(installSteps(navigator.userAgent, navigator.maxTouchPoints ?? 0).steps);
    setMode(standalone ? "installed" : "steps");
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
  return (
    <ol className="flex list-decimal flex-col gap-1 pl-6 text-lg">
      {steps.map((text) => (
        <Step key={text} text={text} />
      ))}
    </ol>
  );
}
