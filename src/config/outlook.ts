import { featureOn } from "./features";

/**
 * Plan #49: Outlook / Microsoft 365. Offered only when the switch is on AND the Azure app's
 * client id and secret are both set; otherwise nothing anywhere mentions Outlook and no
 * Microsoft host is ever contacted. Pure: no `server-only`, no database.
 */
type Env = Record<string, string | undefined>;

export function outlookOffered(env: Env = process.env): boolean {
  return featureOn("outlook", env) && !!env.MS_CLIENT_ID?.trim() && !!env.MS_CLIENT_SECRET?.trim();
}

/** The Azure app's credentials, or null when Outlook isn't offered. Never logged. */
export function outlookClientCredentials(
  env: Env = process.env,
): { clientId: string; clientSecret: string } | null {
  if (!outlookOffered(env)) return null;
  return { clientId: env.MS_CLIENT_ID!.trim(), clientSecret: env.MS_CLIENT_SECRET!.trim() };
}
