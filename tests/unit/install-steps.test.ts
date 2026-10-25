import { describe, expect, it } from "vitest";
import { installSteps } from "@/lib/install-steps";

/* Check 46 P1 / P2: the install steps match the browser in the owner's hand. */
const UA = {
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.41 Mobile/15E148 Safari/604.1",
  iphoneFirefox:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15",
  iphoneEdge:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 EdgiOS/141.0.3537.57 Mobile/15E148 Safari/605.1.15",
  ipadSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  androidChrome:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36",
  androidFirefox: "Mozilla/5.0 (Android 15; Mobile; rv:143.0) Gecko/143.0 Firefox/143.0",
  samsung:
    "Mozilla/5.0 (Linux; Android 15; SM-S921U) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36",
};

describe("installSteps", () => {
  it("iPhone Safari: the three dots, Share, and Open as Web App left on", () => {
    expect(installSteps(UA.iphoneSafari, 5)).toEqual({
      kind: "iphone-safari",
      steps: [
        "Tap the three dots (More) at the bottom of Safari. If you see a Share button there instead, tap it.",
        "Tap Share, then Add to Home Screen.",
        "Leave Open as Web App switched on, then tap Add.",
      ],
    });
  });

  it("Chrome, Edge or Firefox on iPhone: Share in the address bar, never 'Safari'", () => {
    for (const ua of [UA.iphoneChrome, UA.iphoneFirefox, UA.iphoneEdge]) {
      const r = installSteps(ua, 5);
      expect(r.kind).toBe("iphone-other");
      expect(r.steps).toEqual([
        "Tap the Share button in the address bar.",
        "Tap Add to Home Screen. Leave Open as Web App on, then tap Add.",
      ]);
      for (const s of r.steps) expect(s).not.toContain("Safari");
    }
  });

  it("an iPad (a 'Mac' with a touch screen) gets the iPhone Safari steps", () => {
    const r = installSteps(UA.ipadSafari, 5);
    expect(r.kind).toBe("ipad");
    expect(r.steps).toEqual(installSteps(UA.iphoneSafari, 5).steps);
  });

  it("Android, any browser: the browser's menu", () => {
    for (const ua of [UA.androidChrome, UA.androidFirefox, UA.samsung]) {
      const r = installSteps(ua, 5);
      expect(r.kind).toBe("android");
      expect(r.steps).toEqual([
        "Tap your browser's menu (the three dots), then Install app or Add to Home screen.",
        "Tap Install or Add.",
      ]);
    }
  });

  it("a computer: the address bar's install icon", () => {
    for (const ua of [UA.macSafari, UA.windowsChrome]) {
      expect(installSteps(ua, 0).kind).toBe("computer");
    }
  });

  it("only a computer is told to use 'your phone'", () => {
    for (const [name, ua] of Object.entries(UA)) {
      const touch = name === "macSafari" || name === "windowsChrome" ? 0 : 5;
      const text = installSteps(ua, touch).steps.join(" ").toLowerCase();
      expect(text.includes("on your phone"), name).toBe(
        name === "macSafari" || name === "windowsChrome",
      );
    }
  });
});
