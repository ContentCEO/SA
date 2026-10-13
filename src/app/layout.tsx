import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Inter_Tight } from "next/font/google";
import "./globals.css";
import { ServiceWorker } from "@/components/app/service-worker";
import { appUrl } from "@/lib/app-url";

const interTight = Inter_Tight({
  variable: "--font-inter-tight",
  subsets: ["latin"],
  weight: ["400", "600", "900"],
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  variable: "--font-instrument-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["italic"],
  display: "swap",
});

export const metadata: Metadata = {
  // Absolute URLs for the share image, canonical links and sitemap — from APP_URL, never hardcoded.
  metadataBase: new URL(appUrl()),
  title: "Squared Away",
  description: "Your inbox, handled.",
  applicationName: "Squared Away",
  appleWebApp: { capable: true, title: "Squared Away", statusBarStyle: "black" },
  icons: { apple: "/app-icon/apple-180" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#1B1B1B",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${interTight.variable} ${instrumentSerif.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {children}
        <ServiceWorker />
      </body>
    </html>
  );
}
