import { serve } from "inngest/next";
import { inngest } from "@/jobs/client";
import { functions } from "@/jobs/functions";

// Backfill pages can take a while on big inboxes.
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({ client: inngest, functions });
