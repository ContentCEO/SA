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
};

export const LEAD_SOURCES: readonly LeadSource[] = [
  { label: "Thumbtack", domains: ["thumbtack.com"] },
  { label: "Angi / HomeAdvisor", domains: ["angi.com", "angieslist.com", "homeadvisor.com"] },
  { label: "Houzz", domains: ["houzz.com"] },
  { label: "Yelp", domains: ["yelp.com"] },
  { label: "Nextdoor", domains: ["nextdoor.com"] },
  {
    label: "Google (Local Services)",
    domains: ["localservices.google.com", "business.google.com"],
    exact: true,
  },
  { label: "Facebook", domains: ["facebook.com"] },
  { label: "Porch", domains: ["porch.com"] },
  { label: "Bark", domains: ["bark.com"] },
  { label: "Networx", domains: ["networx.com"] },
];

/** Everything else: the customer wrote to the owner themselves. */
export const DIRECT_EMAIL = "Direct email";
