import { Suspense } from "react";
import { AppBadge } from "@/components/app/app-badge";
import { AppHeader } from "@/components/app/app-header";
import { SkipLink } from "@/components/app/skip-link";
import { AssistantBanner } from "@/components/app/assistant-banner";
import { devicePrefs } from "@/lib/device-prefs";
import { ReconnectBanner } from "@/components/app/reconnect-banner";
import { FocusAfterSave } from "@/components/app/focus-after-save";
import { NoSignalGuard } from "@/components/app/no-signal-guard";
import { RefreshOnReturn } from "@/components/app/refresh-on-return";
import { SiteFooter } from "@/components/app/site-footer";
import { StatusBanner } from "@/components/app/status-banner";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { sunlight } = await devicePrefs();
  return (
    <div
      id="sa-app"
      data-contrast={sunlight ? "high" : undefined}
      // Check 8 P2: viewport-fit=cover lets the page run under the notch and home bar, so every
      // side pads for the safe area; the bottom also clears the fixed tab bar on phones.
      className="sa-app mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 pt-[max(1.5rem,env(safe-area-inset-top))] pr-[max(1rem,env(safe-area-inset-right))] pb-[calc(7rem+env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] sm:pb-6"
    >
      {/* Check 32 P12: first stop for Tab, ahead of the logo, five tabs and Sunlight. */}
      <SkipLink />
      <AppHeader sunlight={sunlight} />
      <Suspense fallback={null}>
        <AppBadge />
      </Suspense>
      <ReconnectBanner />
      <StatusBanner />
      <Suspense fallback={null}>
        <AssistantBanner />
      </Suspense>
      <main id="main" tabIndex={-1} className="flex flex-1 flex-col gap-8 outline-none">
        {children}
      </main>
      {/* Check 8 P1: no signal → the tap is stopped and the owner is told nothing was sent. */}
      <NoSignalGuard />
      {/* Check 8 P3: back after a minute away → the screen fetches again (never mid-edit). */}
      <RefreshOnReturn />
      {/* Check 32 P5: after a settings save, focus goes back where the owner left it. */}
      <Suspense fallback={null}>
        <FocusAfterSave />
      </Suspense>
      <SiteFooter />
    </div>
  );
}
