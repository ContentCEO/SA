import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Announcer } from "@/components/app/announcer";
import { ServiceWorker } from "@/components/app/service-worker";
import { appUrl } from "@/lib/app-url";

/*
 * Fonts are self-hosted from ./_fonts (see the README there), so a build never calls Google:
 * Next's Google font loader fetched them at build time and CI failed whenever Google Fonts was
 * unreachable. The files are byte-for-byte the latin ones that loader served, declared the way
 * Google's CSS declared them, so pages render exactly as before. Inter Tight is one variable
 * file, but Google declared it as three single-weight faces (400, 600, 900): the browser renders
 * the nearest of those (500 → 400, 700 and 800 → 900). A "100 900" range would honour every
 * weight and visibly change bold text and sunlight mode — a design change, not a build fix.
 * next/font values must be literals, so the latin unicode-range is written out twice. The CSS
 * family names are the variable names below (Turbopack ignores a font-family declaration).
 */
const interTight = localFont({
  src: [
    { path: "./_fonts/InterTight-latin.woff2", weight: "400", style: "normal" },
    { path: "./_fonts/InterTight-latin.woff2", weight: "600", style: "normal" },
    { path: "./_fonts/InterTight-latin.woff2", weight: "900", style: "normal" },
  ],
  variable: "--font-inter-tight",
  display: "swap",
  adjustFontFallback: "Arial",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
});

const instrumentSerif = localFont({
  src: "./_fonts/InstrumentSerif-Italic-latin.woff2",
  weight: "400",
  style: "italic",
  variable: "--font-instrument-serif",
  display: "swap",
  adjustFontFallback: "Times New Roman",
  declarations: [
    {
      prop: "unicode-range",
      value:
        "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD",
    },
  ],
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
  // Check 8 P2: without "cover", iPhone reports every safe-area inset as 0, so the installed
  // app's tab bar sat on the home-bar strip. Each layout pads for the insets itself.
  viewportFit: "cover",
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
        {/* Check 32 P5: the live region every Notice reads out through. */}
        <Announcer />
        <ServiceWorker />
      </body>
    </html>
  );
}
