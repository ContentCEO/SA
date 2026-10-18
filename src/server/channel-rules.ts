/**
 * Where a lead came from, as pure rules (leads package, B2 / B3 / safety). Decided in code from
 * the sender's address, never by the AI:
 *
 * - `phone`: a voicemail-by-email service (Google Voice's voice-noreply@google.com);
 * - `phone_text`: an email-to-text gateway (5085551234@vtext.com, …@txt.voice.google.com);
 * - `site`: a lead website (Thumbtack, Angi…) — through `leadPlatformOf`, the same matcher the
 *   monthly label and the Reply-To rules use, so "this sender is a platform" never disagrees.
 */
import { EMAIL_TO_TEXT_DOMAINS, PHONE_SERVICES } from "@/config/phone-services";
import { LEAD_SOURCES, OPEN_SITE_HOSTS, type LeadSource } from "@/config/lead-sources";
import { leadPlatformOf } from "./monthly-rules";
import { PUBLIC_WEBMAIL_DOMAINS } from "./sender-rules";

export type ChannelKind = "phone" | "phone_text" | "site";
export type Channel = { key: string; kind: ChannelKind };
export type LeadSite = NonNullable<LeadSource["site"]>;

/** The text-message channel's key (any carrier gateway). */
export const PHONE_TEXT_KEY = "phone_text";

function parts(address: string | null | undefined): { local: string; host: string } | null {
  const s = (address ?? "").trim().toLowerCase().replace(/^<|>$/g, "");
  const at = s.lastIndexOf("@");
  if (at <= 0 || at === s.length - 1) return null;
  const host = s.slice(at + 1).replace(/\.$/, "");
  if (!/^[a-z0-9.-]+$/.test(host)) return null;
  return { local: s.slice(0, at), host };
}

const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/** An address where an email turns into a text message on someone's phone. */
export function isEmailToTextAddress(address: string | null | undefined): boolean {
  const p = parts(address);
  return !!p && EMAIL_TO_TEXT_DOMAINS.some((d) => onDomain(p.host, d));
}

/**
 * Looks like a phone number at some gateway we don't know (5085551234@carrier.example): the
 * local part is exactly 10 digits, or 11 starting with 1, and the domain isn't public webmail
 * (5085551234@gmail.com is a person who likes numbers).
 */
export function looksLikePhoneAddress(address: string | null | undefined): boolean {
  const p = parts(address);
  if (!p || PUBLIC_WEBMAIL_DOMAINS.has(p.host)) return false;
  return /^(1\d{10}|\d{10})$/.test(p.local);
}

/** The lead website for a site key, or null. */
export function siteFor(key: string | null | undefined): LeadSite | null {
  if (!key) return null;
  for (const s of LEAD_SOURCES) if (s.site?.key === key) return s.site;
  return null;
}

/**
 * The fixed "Open <site>" link for a site key — only when it is https and its host is on the
 * allow-list. Anything else is null (no link rather than a wrong one).
 */
export function openSiteUrl(key: string | null | undefined): string | null {
  const site = siteFor(key);
  if (!site) return null;
  try {
    const u = new URL(site.openUrl);
    return u.protocol === "https:" && OPEN_SITE_HOSTS.includes(u.hostname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Where an inbound email came from, from its From address; null for a direct email. */
export function channelOf(fromAddress: string | null | undefined): Channel | null {
  const p = parts(fromAddress);
  if (!p) return null;
  const address = `${p.local}@${p.host}`;
  for (const svc of PHONE_SERVICES)
    if (svc.senders.includes(address)) return { key: svc.key, kind: "phone" };
  if (isEmailToTextAddress(address)) return { key: PHONE_TEXT_KEY, kind: "phone_text" };
  const label = leadPlatformOf(address);
  if (!label) return null;
  const source = LEAD_SOURCES.find((s) => s.label === label);
  return source?.site ? { key: source.site.key, kind: "site" } : null;
}

/** The kind of a stored `threads.lead_channel` key. */
export function channelKind(key: string | null | undefined): ChannelKind | null {
  if (!key) return null;
  if (PHONE_SERVICES.some((s) => s.key === key)) return "phone";
  if (key === PHONE_TEXT_KEY) return "phone_text";
  return siteFor(key) ? "site" : null;
}

/** The plain name shown on a card ("Google Voice", "Thumbtack"), or null. */
export function channelName(key: string | null | undefined): string | null {
  if (!key) return null;
  const svc = PHONE_SERVICES.find((s) => s.key === key);
  if (svc) return svc.label;
  if (key === PHONE_TEXT_KEY) return "Text message";
  return siteFor(key)?.name ?? null;
}
