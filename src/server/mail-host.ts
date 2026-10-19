import "server-only";
import { resolveMx } from "node:dns/promises";
import { mxLookupAllowed } from "@/config/e2e";
import { domainOf, mailHostFor, type MailHost } from "./mail-host-rules";

export type MxResolver = (domain: string) => Promise<{ exchange: string }[]>;

/** How long the sign-up waits on DNS at most; past it (or on any error) the host is "unknown". */
export const MX_LOOKUP_TIMEOUT_MS = 2000;

/**
 * Check 47 P3: who hosts the address's domain, from its MX records. Best effort and bounded: any
 * error or a slow answer gives "unknown", and only the domain is ever looked up. Never throws.
 */
export async function lookupMailHost(
  email: string,
  deps: { resolveMx?: MxResolver; timeoutMs?: number } = {},
): Promise<MailHost> {
  const domain = domainOf(email);
  if (!domain) return "unknown";
  // Public webmail needs no DNS.
  const known = mailHostFor(domain, []);
  if (known !== "unknown") return known;
  // e2e mode never asks real DNS (a stand-in passed by a test still runs).
  if (!deps.resolveMx && !mxLookupAllowed()) return "unknown";
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const records = await Promise.race([
      (deps.resolveMx ?? resolveMx)(domain),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("mx_timeout")),
          deps.timeoutMs ?? MX_LOOKUP_TIMEOUT_MS,
        );
      }),
    ]);
    return mailHostFor(
      domain,
      records.map((r) => r.exchange),
    );
  } catch {
    return "unknown";
  } finally {
    if (timer) clearTimeout(timer);
  }
}
