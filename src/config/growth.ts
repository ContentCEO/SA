/**
 * Squared Away Growth: the services we take on, one-on-one. One list: the
 * services section, the call-request form, its validation and the admin
 * page all read it. The blurbs are the card text on the Growth chapter.
 */
export const GROWTH_SERVICES = [
  {
    value: "google_ads",
    label: "Google ads",
    blurb:
      "Ads that can show up when someone nearby searches for the work you do. We set them up, keep an eye on the spend, and tell you in plain words what's happening.",
  },
  {
    value: "facebook_ads",
    label: "Facebook ads",
    blurb:
      "Ads shown to people in the towns you actually work in. Your own photos, plain words, and a clear way to reach you.",
  },
  {
    value: "instagram_ads",
    label: "Instagram ads",
    blurb:
      "Your finished work, shown to people in the towns you work in. Built from your own photos, never stock pictures.",
  },
  {
    value: "social_posts",
    label: "Social media posts",
    blurb:
      "Regular posts of your real jobs, so your pages don't look abandoned. You send photos from the job; we write the post and put it up.",
  },
  {
    value: "google_business_profile",
    label: "Google Business Profile",
    blurb:
      "The listing people see on Google Maps. We fill it in properly — services, towns, hours, photos — and keep it up to date.",
  },
  {
    value: "reviews",
    label: "Reviews",
    blurb:
      "A simple way to ask your customers for a Google review, and help answering the reviews you get. We never write fake ones.",
  },
  {
    value: "website",
    label: "Website",
    blurb:
      "A clean, fast site that works on a phone and says what you do, where you work and how to reach you.",
  },
] as const;

export type GrowthService = (typeof GROWTH_SERVICES)[number]["value"];

export const GROWTH_SERVICE_VALUES = GROWTH_SERVICES.map((s) => s.value) as [
  GrowthService,
  ...GrowthService[],
];

export const isGrowthService = (v: unknown): v is GrowthService =>
  typeof v === "string" && (GROWTH_SERVICE_VALUES as readonly string[]).includes(v);

export function growthServiceLabel(value: GrowthService): string {
  return GROWTH_SERVICES.find((s) => s.value === value)!.label;
}

/**
 * The You-own-everything pledge (agreed 2026-10-16: no percentage of the business): for
 * each service, what the client owns. `Record<GrowthService, …>` makes a new
 * service without an entry a compile error, and tests/unit/growth-copy.test.ts checks that the
 * pledge on /growth names every one.
 */
export const GROWTH_OWNED: Record<GrowthService, string> = {
  google_ads: "your ad accounts",
  facebook_ads: "your ad accounts",
  instagram_ads: "your ad accounts",
  social_posts: "your social media pages and posts",
  google_business_profile: "your Google Business Profile",
  reviews: "your reviews",
  website: "your website and its domain",
};

/** Services in the page's order, once each; anything that isn't a service is dropped. */
export function growthServicesFrom(values: readonly unknown[]): GrowthService[] {
  const picked = new Set(values.filter(isGrowthService));
  return GROWTH_SERVICE_VALUES.filter((v) => picked.has(v));
}

/** Service ids for the labels stored in a Growth call request ("Google ads" → google_ads). */
export function growthServicesFromLabels(labels: readonly string[]): GrowthService[] {
  const wanted = new Set(labels.map((l) => l.trim().toLowerCase()));
  return GROWTH_SERVICES.filter((s) => wanted.has(s.label.toLowerCase())).map((s) => s.value);
}
