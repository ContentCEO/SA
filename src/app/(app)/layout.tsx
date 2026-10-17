import { Suspense } from "react";
import { AppBadge } from "@/components/app/app-badge";
import { AppHeader } from "@/components/app/app-header";
import { AssistantBanner } from "@/components/app/assistant-banner";
import { devicePrefs } from "@/lib/device-prefs";
import { ReconnectBanner } from "@/components/app/reconnect-banner";
import { NoSignalGuard } from "@/components/app/no-signal-guard";
import { SiteFooter } from "@/components/app/site-footer";
import { StatusBanner } from "@/components/app/status-banner";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { sunlight } = await devicePrefs();
  return (
    <div
      data-contrast={sunlight ? "high" : undefined}
      className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 px-4 pt-6 pb-28 sm:pb-6"
    >
      <AppHeader sunlight={sunlight} />
      <Suspense fallback={null}>
        <AppBadge />
      </Suspense>
      <ReconnectBanner />
      <StatusBanner />
      <Suspense fallback={null}>
        <AssistantBanner />
      </Suspense>
      <main className="flex flex-1 flex-col gap-8">{children}</main>
      {/* Check 8 P1: no signal → the tap is stopped and the owner is told nothing was sent. */}
      <NoSignalGuard />
      <SiteFooter />
    </div>
  );
}
