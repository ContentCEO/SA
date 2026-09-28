import { AppHeader } from "@/components/app/app-header";
import { SiteFooter } from "@/components/app/site-footer";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 px-4 py-6">
      <AppHeader />
      <main className="flex flex-1 flex-col gap-8">{children}</main>
      <SiteFooter />
    </div>
  );
}
