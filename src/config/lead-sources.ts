/**
 * Where quote requests come from (plan #35 monthly summary): the sender's domain mapped onto
 * OUR fixed labels. Only these labels and counts ever leave the app — never an address.
 *
 * A domain matches itself and its subdomains (mail.thumbtack.com is Thumbtack), unless the
 * entry is `exact`: Google's own hosts only match exactly, because every Google service
 * (calendar, forms, Workspace) writes from google.com. facebookmail.com is left out on purpose:
 * it covers every Facebook notification, not just leads.
 */
export type LeadSource = {
  label: string;
  domains: readonly string[];
  /** Match these hosts exactly, never their subdomains. */
  exact?: true;
  /**
   * Leads package (B2): a lead website. Its emails become lead cards with "Open <name>", a
   * FIXED https link (never one read from an email) whose host is on OPEN_SITE_HOSTS. No site
   * takes an email reply that reaches the customer (until a real sample shows one does), so
   * they are never drafted. `null`: recognised for the monthly label only.
   */
  site: { key: string; name: string; openUrl: string } | null;
};

export const LEAD_SOURCES: readonly LeadSource[] = [
  {
    label: "Thumbtack",
    domains: ["thumbtack.com"],
    site: { key: "thumbtack", name: "Thumbtack", openUrl: "https://www.thumbtack.com/" },
  },
  {
    label: "Angi / HomeAdvisor",
    domains: ["angi.com", "angieslist.com", "homeadvisor.com"],
    site: { key: "angi", name: "Angi", openUrl: "https://www.angi.com/" },
  },
  {
    label: "Houzz",
    domains: ["houzz.com"],
    site: { key: "houzz", name: "Houzz", openUrl: "https://www.houzz.com/" },
  },
  {
    label: "Yelp",
    domains: ["yelp.com"],
    site: { key: "yelp", name: "Yelp", openUrl: "https://biz.yelp.com/" },
  },
  {
    label: "Nextdoor",
    domains: ["nextdoor.com"],
    site: { key: "nextdoor", name: "Nextdoor", openUrl: "https://nextdoor.com/" },
  },
  {
    label: "Google (Local Services)",
    domains: ["localservices.google.com", "business.google.com"],
    exact: true,
    // Local Services leads are answered in the Local Services dashboard.
    site: {
      key: "google_lsa",
      name: "Google Local Services",
      openUrl: "https://ads.google.com/localservices/",
    },
  },
  // facebook.com mail is mostly account and page notifications: treating it as a lead site
  // would turn every one of them into a lead card.
  { label: "Facebook", domains: ["facebook.com"], site: null },
  {
    label: "Porch",
    domains: ["porch.com"],
    site: { key: "porch", name: "Porch", openUrl: "https://porch.com/" },
  },
  {
    label: "Bark",
    domains: ["bark.com"],
    site: { key: "bark", name: "Bark", openUrl: "https://www.bark.com/" },
  },
  {
    label: "Networx",
    domains: ["networx.com"],
    site: { key: "networx", name: "Networx", openUrl: "https://www.networx.com/" },
  },
];

/**
 * The only hosts an "Open <site>" link may point at (leads package, B2). A test holds every
 * configured `openUrl` to this list and to https.
 */
export const OPEN_SITE_HOSTS: readonly string[] = [
  "www.thumbtack.com",
  "www.angi.com",
  "www.houzz.com",
  "biz.yelp.com",
  "nextdoor.com",
  "ads.google.com",
  "porch.com",
  "www.bark.com",
  "www.networx.com",
];

/** Everything else: the customer wrote to the owner themselves. */
export const DIRECT_EMAIL = "Direct email";
