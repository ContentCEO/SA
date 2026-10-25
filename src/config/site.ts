/** Business facts. Support email and app URL come from env — never hardcode them. */
export const siteConfig = {
  name: "Squared Away",
  tagline: "Your inbox, handled.",
  operator: "Davi Chaves",
  /** Davi's remodeling company (the Growth "who does the work" copy and About). */
  company: "A&C Construction",
  location: "Massachusetts, United States",
  phone: "978-201-9763",
  /**
   * Check 2 P6: Davi's own photo (no stock photos), shown in the homepage About section and
   * /growth's "who does the work". Null renders text only, no placeholder box. When it arrives:
   * put it in public/brand/ and set it here.
   */
  operatorPhoto: null as { src: string; alt: string } | null,
  copyright: "© 2026 Squared Away — Davi Chaves, Massachusetts",
} as const;

/**
 * Check 33 P4: when each public page's words last changed, for the sitemap's lastModified
 * (YYYY-MM-DD). Bump the date when that page's copy changes; the legal pages use TERMS_VERSION.
 */
export const CONTENT_DATES = { home: "2026-10-16", growth: "2026-10-16" } as const;
