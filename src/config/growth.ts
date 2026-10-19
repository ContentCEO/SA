import { siteConfig } from "@/config/site";

/**
 * Squared Away Growth: the services we take on, one-on-one. One list: the
 * services section, the call-request form, its validation and the admin
 * page all read it. The blurbs are the card text on the Growth chapter.
 *
 * `includes` (Check 3 P1): 2 to 4 short "you get" lines under each card. These are the review's
 * DRAFTS, waiting for the operator's own words (no prices, no result promises; the copy test checks).
 */
export const GROWTH_SERVICES = [
  {
    value: "google_ads",
    label: "Google ads",
    blurb:
      "Ads that can show up when someone nearby searches for the work you do. We set them up, keep an eye on the spend, and tell you in plain words what's happening.",
    includes: [
      "Ads set up for the work and towns you pick",
      "A monthly cap on ad money that you set",
      "A short note each month on what ran",
    ],
  },
  // Check 2 P4 / Check 3 P2: home-repair ads on Meta fall under the Housing special ad category
  // (at least a 15-mile radius around each place, no ZIP-code targeting). Never promise
  // town-level targeting for the Facebook or Instagram ads.
  {
    value: "facebook_ads",
    label: "Facebook ads",
    blurb:
      "Ads shown to people in and around the towns you work in. Your own photos, plain words, and a clear way to reach you.",
    includes: ["Ads built from your own job photos", "You see every ad before it runs"],
  },
  {
    value: "instagram_ads",
    label: "Instagram ads",
    blurb:
      "Your finished work, shown to people in and around the towns you work in. Built from your own photos, never stock pictures.",
    includes: ["Ads built from your own job photos", "You see every ad before it runs"],
  },
  {
    value: "social_posts",
    label: "Social media posts",
    blurb:
      "Regular posts of your real jobs, so your pages don't look abandoned. You send photos from the job; we write the post and put it up.",
    includes: ["Posts written from the photos you send", "You see each post before it goes up"],
  },
  {
    value: "google_business_profile",
    label: "Google Business Profile",
    blurb:
      "The listing people see on Google Maps. We fill it in properly — services, towns, hours, photos — and keep it up to date.",
    includes: ["Services, towns, hours and photos filled in", "Checked and updated every month"],
  },
  {
    value: "reviews",
    label: "Reviews",
    // Check 3 P5: the owner sends the ask, to every customer; Growth never messages customers
    // (Google's policy bans asking only some customers, and any incentive).
    blurb:
      "Your Google review link and a short message you send to every customer yourself, plus help answering the reviews you get. We never write fake ones, and we never message your customers.",
    includes: [
      "Your Google review link and a short message you can send",
      "Help writing replies to the reviews you get",
    ],
  },
  {
    value: "website",
    label: "Website",
    blurb:
      "A clean, fast site that works on a phone and says what you do, where you work and how to reach you.",
    includes: [
      "A site that works on a phone",
      "Your phone number on every screen",
      "A quote form that comes to your email",
    ],
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

/**
 * Check 3 P4: the form's extra choice for someone who just wants more work. Not a service: the
 * cards never show it. No comma in the label (a stored request's services are comma-separated).
 */
export const GROWTH_NOT_SURE = {
  value: "not_sure",
  label: "Not sure yet — tell me what to do first",
} as const;

/** The form's checkboxes: every service, then "Not sure yet" last. */
export const GROWTH_REQUEST_OPTIONS = [
  ...GROWTH_SERVICES.map((s) => ({ value: s.value, label: s.label })),
  GROWTH_NOT_SURE,
] as const;
export type GrowthRequestOption = GrowthService | typeof GROWTH_NOT_SURE.value;
export const GROWTH_REQUEST_VALUES = GROWTH_REQUEST_OPTIONS.map((o) => o.value) as [
  GrowthRequestOption,
  ...GrowthRequestOption[],
];

export function growthRequestLabel(value: GrowthRequestOption): string {
  return GROWTH_REQUEST_OPTIONS.find((o) => o.value === value)!.label;
}

/**
 * Check 5 P2: "How did you hear about …?" on the call form, optional. The value id is stored,
 * never the label. Values may be added; readers show an unknown stored id as it is.
 */
export const GROWTH_HEARD_FROM = [
  { value: "google", label: "Searched on Google" },
  { value: "social", label: "Facebook or Instagram" },
  { value: "supply_house", label: "A supply house or lumber yard" },
  { value: "group", label: "A trade group, BNI or an event" },
  { value: "contractor", label: "Another contractor told me" },
  { value: "app", label: "I use the Squared Away app" },
  { value: "letter", label: `A letter or card from ${siteConfig.operator.split(" ")[0]}` },
  { value: "other", label: "Something else" },
] as const;
export type GrowthHeardFrom = (typeof GROWTH_HEARD_FROM)[number]["value"];
export const GROWTH_HEARD_FROM_VALUES = GROWTH_HEARD_FROM.map((h) => h.value) as [
  GrowthHeardFrom,
  ...GrowthHeardFrom[],
];
/** The label for a stored id; an id this code doesn't know comes back as it is. */
export function growthHeardFromLabel(value: string): string {
  return GROWTH_HEARD_FROM.find((h) => h.value === value)?.label ?? value;
}
