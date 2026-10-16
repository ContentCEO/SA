import "server-only";
import { appUrl } from "@/lib/app-url";

/** Our own host names (APP_URL's and this request's), never stored as a "came from" site. */
export function ownHosts(h: Headers): string[] {
  const hosts: string[] = [];
  try {
    hosts.push(new URL(appUrl()).hostname);
  } catch {
    // A malformed APP_URL just means one fewer host to leave out.
  }
  for (const v of [h.get("x-forwarded-host"), h.get("host")]) {
    if (v) hosts.push(v.split(",")[0].trim().replace(/:\d+$/, "").toLowerCase());
  }
  return hosts;
}
