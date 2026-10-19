import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { GROWTH_SERVICES } from "@/config/growth";
import { pricing } from "@/config/pricing";
import { siteConfig } from "@/config/site";

/**
 * Search engines' structured data for the homepage: who runs it (Organization) and what it is
 * (SoftwareApplication) with the real prices from src/config/pricing.ts. No ratings or reviews
 * (we have none), and no offer for the trial (it isn't a product on its own: it can't send to
 * customers). Pure, so it is unit-tested.
 */
export function structuredData(siteUrl: string, opts: { supportEmail?: string } = {}) {
  const usd = (cents: number) => (cents / 100).toFixed(2);
  const plans = Object.values(pricing.plans).map((p) => ({
    "@type": "Offer",
    name: `${p.name} plan`,
    price: usd(p.amountCents),
    priceCurrency: "USD",
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: usd(p.amountCents),
      priceCurrency: "USD",
      unitText: "MONTH",
    },
  }));
  const setup = {
    "@type": "Offer",
    name: `${pricing.setupFee.name} (one time)`,
    price: usd(pricing.setupFee.amountCents),
    priceCurrency: "USD",
  };
  return [
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      name: siteConfig.name,
      url: siteUrl,
      telephone: `+1-${siteConfig.phone}`,
      // Check 33 P3: what Google's Organization guide lists to identify the business. The logo is
      // the 512px home-screen icon the manifest already serves; the address stops at the state
      // (no street); the email only when SUPPORT_EMAIL is set, never typed here.
      logo: new URL("/app-icon/512", siteUrl).toString(),
      address: { "@type": "PostalAddress", addressRegion: "MA", addressCountry: "US" },
      ...(opts.supportEmail?.trim() ? { email: opts.supportEmail.trim() } : {}),
    },
    {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: siteConfig.name,
      url: siteUrl,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      description:
        "AI email help for contractors: sorts your business email, drafts replies in your voice, and drafts quote follow-ups. Nothing goes out without your okay.",
      offers: [setup, ...plans],
    },
  ];
}

/** JSON for a <script type="application/ld+json">, with `<` escaped so it can't close the tag. */
export function jsonLd(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Check 33 P2: /growth's structured data, one Service. No offers or price (Growth has no price
 * list), no ratings or reviews (we have none), no areaServed (Davi hasn't picked one). Pure.
 */
export function growthStructuredData(siteUrl: string) {
  const base = siteUrl.replace(/\/+$/, "");
  return {
    "@context": "https://schema.org",
    "@type": "Service",
    name: "Squared Away Growth",
    url: `${base}/growth`,
    description: growthCopy.meta.description,
    serviceType: GROWTH_SERVICES.map((s) => s.label),
    provider: {
      "@type": "Organization",
      name: siteConfig.name,
      url: base,
      telephone: `+1-${siteConfig.phone}`,
      address: { "@type": "PostalAddress", addressRegion: "MA", addressCountry: "US" },
      founder: { "@type": "Person", name: siteConfig.operator },
    },
  };
}
