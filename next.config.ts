import type { NextConfig } from "next";
import { securityHeaders } from "./src/config/security-headers";

const nextConfig: NextConfig = {
  // /privacy and /terms read these files at request time (legal-page.tsx); make sure the
  // server bundle carries them if those pages are ever rendered on demand on Vercel.
  outputFileTracingIncludes: {
    "/privacy": ["./docs/privacy-policy.md"],
    "/terms": ["./docs/terms.md"],
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
