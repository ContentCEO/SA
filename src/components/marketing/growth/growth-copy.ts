import { GROWTH_SERVICES } from "@/config/growth";
import { siteConfig } from "@/config/site";

/**
 * Every Squared Away Growth string. Names, the company and the phone number come
 * from siteConfig, never typed here. tests/unit/growth-copy.test.ts guards this
 * file: no prices, no promises we can't keep, no features that aren't live, and
 * no pronouns for Davi: use the name, or "personally".
 */
const operator = siteConfig.operator;
const davi = operator.split(" ")[0]!;
const company = siteConfig.company;
const phone = siteConfig.phone;
/** "Massachusetts", from siteConfig.location (Check 33 P2: never typed twice). */
const homeState = siteConfig.location.split(",")[0]!.trim();

export const growthCopy = {
  hero: {
    link: "Want more work coming in? We also run ads, your Google listing and reviews",
  },
  header: {
    link: "Growth",
  },
  bridge: {
    region: "Introducing Squared Away Growth",
    serif: "The app keeps you squared away.",
    heavy: "Need more jobs? We'll do the marketing for you.",
    body: "Squared Away Growth is a separate service for anyone in the trades: ads, your Google listing, reviews and your website. It never touches your inbox, and you don't need the app to use it.",
  },
  /** Labels on the decorative switch graphic (aria-hidden): never announced. */
  switch: {
    from: "Your inbox",
    to: "Your marketing",
  },
  bar: {
    nav: "Growth",
    link: `Ask ${davi} to call me`,
  },
  opener: {
    region: "Squared Away Growth",
    // Check 33 P2: the words owners search, and the state once. No town, street or office.
    eyebrow: `Squared Away Growth · marketing for contractors, run from ${homeState}`,
    serif: "the marketing side,",
    heavy: "done for you.",
    body: "Google ads, Facebook and Instagram ads, social media posts, your Google Business Profile, reviews and your website. We do the work, one-on-one, so you can stay on the job.",
    homeOnly: `For now, ${operator} does every job personally — the same person who builds the app.`,
    button: `Ask ${davi} to call me`,
    call: `Call ${phone}`,
    /** Homepage only: the way to Growth's own page. */
    pageLink: "See everything Growth does",
  },
  services: {
    region: "What we take on",
    serif: "what we take on,",
    heavy: "so you don't have to.",
    items: GROWTH_SERVICES.map((s) => ({ title: s.label, body: s.blurb, includes: s.includes })),
    /** Check 3 P1: the screen-reader name of each card's "you get" list. */
    includesLabel: (service: string) => `What you get with ${service}`,
  },
  /**
   * The pledge (agreed 2026-10-16: no percentage of the business). Names what the
   * client owns for every service in src/config/growth.ts (GROWTH_OWNED; the copy test checks).
   */
  pledge: {
    region: "You own everything",
    serif: "our pledge,",
    heavy: "you own everything.",
    body: "Your Google Business Profile and your reviews, your ad accounts, your social media pages and posts, your website and its domain, and your photos are in your name, and they stay yours if you stop.",
    percent: "We never take a percentage of your jobs or your business.",
  },
  how: {
    region: "How Growth works",
    serif: "how it works,",
    heavy: "one call to start.",
    steps: [
      {
        title: `Ask ${davi} to call you`,
        body: "Tell us about your business and the work you want more of. It costs nothing, and there's no obligation.",
      },
      {
        title: "We make a plan",
        body: `${davi} looks at what you have today — your Google listing, your pages, your site, your reviews — and tells you plainly what to do first and what it costs.`,
      },
      {
        title: "We do the work",
        body: "You keep running jobs. We handle the setup and the upkeep, and keep you posted in plain words.",
      },
    ],
  },
  rules: {
    region: "Ground rules",
    serif: "the ground rules,",
    heavy: "in plain words.",
    items: [
      {
        title: "Your email stays out of it",
        body: "Growth never touches your inbox. If you use the Squared Away app, your email is used only to run the app for you, like sorting, drafts and follow-ups, and never for Growth ads, posts or anything else outside the app.",
      },
      {
        title: "No made-up reviews",
        body: "We help you ask real customers. We never write reviews, buy followers, post photos of someone else's work, or offer anything in return for a review.",
      },
      {
        title: "A clear price before any work",
        body: "Every shop needs something different, so there's no price list here. You'll get a clear price before anything starts.",
      },
      {
        title: "App or no app",
        body: "You don't need the app to work with us, and you don't need Growth to use the app.",
      },
    ],
  },
  who: {
    region: "Who does the work",
    serif: "who does the work,",
    heavy: `${davi}, personally.`,
    body: `For now, every Growth job is done by ${operator}, who runs ${company}, a remodeling company in Massachusetts, and builds the Squared Away app too. You talk to the person doing the work.`,
  },
  /** Check 2 P6: shown only when src/config/growth-proof.ts has a live, permitted item. */
  proof: {
    region: "What it looks like",
    serif: "what it looks like,",
    heavy: "for real.",
    byline: (shop: string, town: string) => `${shop}, ${town}`,
    imageAlt: (shop: string, when: string) => `${shop}: ${when}`,
    link: (shop: string) => `See ${shop}'s work`,
  },
  faq: {
    region: "Growth questions",
    serif: "before you call,",
    heavy: "fair questions.",
    items: [
      {
        q: "Do I need the Squared Away app?",
        a: "No. Growth is for anyone in the trades — carpenters, plumbers, electricians, roofers, painters, landscapers, heating and cooling, and more. If you use the app too, the two are kept separate.",
      },
      {
        // Check 34 P4 (draft words, waiting for the operator's okay). No agency is named.
        q: "How is this different from a marketing agency?",
        a: "You talk to the person doing the work, who runs a remodeling company too. There's no sales team and no hand-off. Your email is never part of it. You get a clear price before anything starts.",
      },
      {
        q: "What does it cost?",
        a: `It depends on what you need. ${davi} talks it through with you on the free call and gives you a clear price before any work starts.`,
      },
      {
        // Check 3 P6 (draft words, waiting for the operator's okay): commercial policy.
        q: "Who pays for the ads?",
        a: `You do, straight to Google or Facebook, from an ad account in your business's name. You set the monthly limit. ${davi}'s fee for running them is separate, and you'll know it before any work starts.`,
      },
      {
        // Check 2 P4: Meta's Housing special ad category (15-mile minimum radius, no ZIP codes).
        q: "Can my Facebook ads show only in my town?",
        a: `Not exactly. Facebook and Instagram treat home-repair ads like housing ads, so they reach people within at least 15 miles of a place you pick. ${davi} explains what that means for your area on the call.`,
      },
      {
        q: "Is the call really free?",
        a: "Yes. No cost and no obligation. If we don't think we can help, we'll tell you.",
      },
      {
        q: "Will you see my customers' emails?",
        /** Rendered as before + a link to /privacy + after. */
        a: {
          before:
            "Growth work never uses your inbox. Nothing the app reads from your email is used for ads, posts or anything else we do for Growth. The app's ",
          link: "privacy policy",
          after: ` explains the few times a person might look, such as when you ask us for help. Even when ${davi} looks at your app account because you asked for help, nothing seen there is used for Growth.`,
        },
      },
      {
        q: "Who will I be dealing with?",
        a: `${operator}, directly. For now, ${davi} does the work personally.`,
      },
    ],
  },
  call: {
    region: `Ask ${davi} to call me`,
    serif: "want more work,",
    heavy: `ask ${davi} to call you.`,
    body: `Leave your number and what you want help with. ${davi} calls you back personally.`,
    talkNow: "Rather talk now?",
    callLink: `Call ${phone}`,
    textLink: `Text ${phone}`,
  },
  form: {
    name: "Your name",
    phone: "Phone",
    phoneHint: `${davi} will call you on this number.`,
    email: "Email",
    emailHint: "In case we can't reach you by phone.",
    trade: "Trade",
    otherTrade: "Another trade",
    /** Check 45 P5 (optional). */
    state: "Which state do you work in? (optional)",
    stateEmpty: "Choose one (optional)",
    /** Check 5 P2 (optional). */
    heardFrom: `How did you hear about ${davi}? (optional)`,
    heardFromEmpty: "Choose one (optional)",
    sentBy: "Who sent you? (optional)",
    servicesLegend: "What do you want help with?",
    servicesHint: "Pick all that apply, or Not sure yet.",
    note: "Anything else? (optional)",
    noteHint: "The towns you work in, the jobs you want more of — anything that helps.",
    honeypot: "Leave this empty",
    submit: `Ask ${davi} to call me`,
    pending: "Sending…",
    privacy:
      "We only use this to contact you about Squared Away Growth. No newsletters, and we never sell it.",
  },
  errors: {
    nameEmpty: "Tell us your name.",
    nameLong: "That name is too long.",
    phoneEmpty: `Tell us a phone number so ${davi} can call you.`,
    phoneBad: "That number doesn't look right. Use a 10-digit number, like 617-555-0142.",
    emailEmpty: "Tell us your email address.",
    emailBad: "That doesn't look like an email address.",
    trade: "Pick your trade.",
    servicesNone: "Pick at least one thing you want help with.",
    serviceUnknown: "Pick from the list.",
    stateUnknown: "Pick a state from the list.",
    sentByLong: "Keep it under 80 characters.",
    noteLong: "Keep it under 500 characters.",
    rateLimited: `Too many tries from here. Try again in an hour, or call or text ${phone}.`,
    saveFailed: `We couldn't save that just now. Try again in a minute, or call or text ${phone}.`,
  },
  success: {
    serif: "thanks,",
    heavy: "we'll call you.",
    // The phone they gave goes between these two, kept on one line so it's easy to check.
    withPhoneBefore: `${davi} will call you at `,
    withPhoneAfter: ".",
    noPhone: `${davi} will call you soon.`,
    soonerBefore: "Want to talk sooner? Call or text ",
    soonerAfter: ".",
    done: "Nothing else to do for now.",
  },
  closing: {
    region: "The app",
    body: "Squared Away also makes an inbox app for the trades. It sorts your business email and drafts replies in your own voice, and nothing goes out without your okay.",
    link: "See the app",
  },
  page: {
    homeLabel: "Squared Away home",
    appLink: "The app",
    callLink: `Ask ${davi} to call me`,
  },
  meta: {
    // Check 33 P2: what owners type into Google ("contractor marketing …").
    title: "Contractor marketing, done for you · Squared Away Growth",
    description: `Google and Facebook ads, Google Business Profile, reviews and websites for anyone in the trades, done one-on-one by ${operator}, a ${homeState} remodeler.`,
    twitterDescription: `Ads, posts, reviews, your Google listing and your website, done for you, one-on-one. For anyone in the trades. Ask ${davi} to call you.`,
  },
  /**
   * The one mention of Growth the signed-in app may show (GrowthMention, on the More screen
   * only). Static and the same for every owner, never tied to anything from their email:
   * CLAUDE.md "Growth cross-sell rule", tests/unit/growth-boundary.test.ts.
   */
  appMention: {
    label: "Grow your business",
    line: "Want more work coming in? Squared Away Growth is a separate service. Nothing from your email is used for it.",
    link: "See Squared Away Growth",
  },
  admin: {
    heading: (n: number) => `Waitlist and Growth calls (${n})`,
    empty: "Nobody yet. Both forms are on the public home page.",
    growthChip: "Growth call",
    appChip: "App waitlist",
    wants: (labels: string[]) => `Wants help with: ${labels.join(", ")}`,
    asked: (when: string) => `Asked for a call ${when}`,
    call: (p: string) => `Call ${p}`,
    nameGiven: (n: string) => `Name given: ${n}`,
    /** Check 5 P2 / Check 45 P5: what they told us on the form, never anything else. */
    heard: (label: string) => `Heard: ${label}`,
    sentBy: (who: string) => `Sent by: ${who}`,
    worksIn: (state: string) => `Works in ${state}`,
    theirTime: (time: string) => `Their time now: ${time}`,
    tradeGiven: (t: string) => `Trade given: ${t}`,
    growthOnly: "Not on the app waitlist. Asking for a Growth call never invites anyone.",
    /** Check 5 P5: a Growth-only row whose email already has an app account or invite. */
    growthOnlyHasAccount: "Also uses the app.",
    growthOnlyInvited: "Invited to the app, not signed in yet.",
    /**
     * Check 5 P5: which line a Growth-only row shows, from account and invite existence by email
     * only (listWaitlist's inviteState) — never plan, status, mailbox or anything from Gmail.
     */
    growthOnlyLine(inviteState: string): string {
      return inviteState === "has_account"
        ? "Also uses the app."
        : inviteState === "invited"
          ? "Invited to the app, not signed in yet."
          : "Not on the app waitlist. Asking for a Growth call never invites anyone.";
    },
    /** Check 2 P3: the hidden trap field was filled, but the rest looked real. */
    trapFlag: "Might be a bot: the hidden field was filled",
    growthOnlyError: "That's a Growth call request, not an app sign-up, so nobody was invited.",
  },
  /**
   * Check 2 P2: the visitor's confirmation. Nothing the visitor typed goes in it (anyone can type
   * someone else's address), same rule as the waitlist's "You're on the list".
   */
  confirm: {
    subject: "Your Squared Away Growth call",
    serif: "thanks for asking,",
    heavy: "here's what's next.",
    lines: [
      `${davi} will call you for your free Squared Away Growth call.`,
      `Save this number so you know it's ${davi}: ${phone}`,
      "Have these handy if you can: your Google listing link, your website, and the jobs you want more of.",
      "Nothing to do until then.",
    ],
    footer:
      "You're getting this because this address asked for a Squared Away Growth call on our website. We won't email you about anything else.",
  },
  notify: {
    subject: "New Growth call request",
    serif: "new request,",
    heavy: "call them back.",
    lines: [
      "Someone asked for a free Growth call on the website.",
      "Open the admin page to see who it is and call them back.",
    ],
    button: "Open admin",
    footer: "Names and numbers stay in the admin page, not in this email.",
  },
} as const;
