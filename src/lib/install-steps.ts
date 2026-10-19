/**
 * Check 46 P1 / P2: the "Get the app" steps for the browser in the owner's hand, when the
 * browser doesn't offer its own Install button (that button always wins). Pure, so every
 * user agent is tested.
 *
 * - iPhone Safari (and iPad, which says it's a Mac but has a touch screen): iOS 26's Compact
 *   tab bar hides Share behind the three dots, and the Add sheet's "Open as Web App" must stay
 *   on or the owner gets a plain bookmark with no notifications.
 * - Chrome, Edge or Firefox on iPhone: Share sits in the address bar.
 * - Android, any browser: the browser's menu.
 * - A computer: the address bar's install icon — the only case that mentions "your phone".
 */
export type InstallKind = "iphone-safari" | "iphone-other" | "ipad" | "android" | "computer";

export const INSTALL_STEPS: Record<InstallKind, string[]> = {
  "iphone-safari": [
    "Tap the three dots (More) at the bottom of Safari. If you see a Share button there instead, tap it.",
    "Tap Share, then Add to Home Screen.",
    "Leave Open as Web App switched on, then tap Add.",
  ],
  "iphone-other": [
    "Tap the Share button in the address bar.",
    "Tap Add to Home Screen. Leave Open as Web App on, then tap Add.",
  ],
  ipad: [],
  android: [
    "Tap your browser's menu (the three dots), then Install app or Add to Home screen.",
    "Tap Install or Add.",
  ],
  computer: [
    "In Chrome or Edge, click the install icon at the right end of the address bar, or open the browser menu and choose Install Squared Away.",
    "On your phone, open this page and you'll see the steps for it.",
  ],
};
INSTALL_STEPS.ipad = INSTALL_STEPS["iphone-safari"];

export function installSteps(
  ua: string,
  maxTouchPoints: number,
): { kind: InstallKind; steps: string[] } {
  const kind = installKind(ua, maxTouchPoints);
  return { kind, steps: INSTALL_STEPS[kind] };
}

function installKind(ua: string, maxTouchPoints: number): InstallKind {
  if (/iPhone|iPod|iPad/.test(ua)) {
    return /CriOS|EdgiOS|FxiOS/.test(ua) ? "iphone-other" : "iphone-safari";
  }
  // iPadOS asks for desktop sites: a "Macintosh" with a touch screen is an iPad.
  if (/Macintosh/.test(ua) && maxTouchPoints > 1) return "ipad";
  if (/Android/.test(ua)) return "android";
  return "computer";
}

/** The words shown in bold, as before: what the owner looks for on screen. */
export const INSTALL_BOLD =
  /(Add to Home Screen|Add to Home screen|Open as Web App|Install Squared Away|Install app|Share|Install|Add|More)/;
