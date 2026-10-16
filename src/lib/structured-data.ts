import { pricing } from "@/config/pricing";
import { siteConfig } from "@/config/site";

/**
 * Search engines' structured data for the homepage: who runs it (Organization) and what it is
 * (SoftwareApplication) with the real prices from src/config/pricing.ts. No ratings or reviews
 * (we have none), and no offer for the trial (it isn't a product on its own: it can't send to
 * customers). Pure, so it is unit-tested.
 */
export function structuredData(siteUrl: string) {
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
