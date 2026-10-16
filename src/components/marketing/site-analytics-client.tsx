"use client";

import { Analytics } from "@vercel/analytics/next";
import { beforeSend } from "@/lib/analytics-rules";

export function SiteAnalyticsClient() {
  return <Analytics mode="production" beforeSend={beforeSend} />;
}
