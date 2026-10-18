import type { NextConfig } from "next";
import { securityHeaders } from "./src/config/security-headers";

const nextConfig: NextConfig = {
  // Check 26 P9: don't announce the framework (x-powered-by: Next.js).
  poweredByHeader: false,
  // /privacy and /terms read these files at request time (legal-page.tsx); make sure the
  // server bundle carries them if those pages are ever rendered on demand on Vercel.
  outputFileTracingIncludes: {
    "/privacy": ["./docs/privacy-policy.md"],
    "/terms": ["./docs/terms.md"],
    // The home-screen icons are drawn in Inter Tight Black (Check 7 P3); built at deploy time,
    // but carried along in case one is ever drawn on demand.
    "/app-icon/[size]": ["./src/app/_og/InterTight-Black.ttf"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders() },
      {
        // Always fetch the latest service worker so fixes reach installed apps at once.
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Content-Type", value: "application/javascript; charset=utf-8" },
        ],
      },
    ];
  },
};

export default nextConfig;
