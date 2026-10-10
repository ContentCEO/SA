import { AppHeader } from "@/components/app/app-header";
import { devicePrefs } from "@/lib/device-prefs";
import { ReconnectBanner } from "@/components/app/reconnect-banner";
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
      <ReconnectBanner />
      <StatusBanner />
      <main className="flex flex-1 flex-col gap-8">{children}</main>
      <SiteFooter />
    </div>
  );
}
