/** Business facts. Support email and app URL come from env — never hardcode them. */
export const siteConfig = {
  name: "Squared Away",
  tagline: "Your inbox, handled.",
  operator: "Davi Chaves",
  /** Davi's remodeling company (the Growth "who does the work" copy and About). */
  company: "A&C Construction",
  location: "Massachusetts, United States",
  phone: "978-201-9763",
  copyright: "© 2026 Squared Away — Davi Chaves, Massachusetts",
} as const;
