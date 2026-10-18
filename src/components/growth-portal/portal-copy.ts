import { siteConfig } from "@/config/site";

/**
 * Every string on the signed-in Growth screens (/start and /my-growth) that isn't a number's
 * source line (those live in src/server/growth-client-rules.ts). Names and the phone number
 * come from siteConfig. tests/unit/growth-portal.test.ts guards it like the public Growth copy:
 * no pronouns for Davi, no claims that Growth earned the money, no promises of results.
 */
const davi = siteConfig.operator.split(" ")[0]!;
const phone = siteConfig.phone;

export const portalCopy = {
  start: {
    title: "Where to?",
    serif: "welcome back,",
    heavy: "where to?",
    inbox: "My inbox · Squared Away",
    inboxLine: "Your business email, sorted, with replies waiting for your okay.",
    growth: "My Growth dashboard",
    growthLine: `Your numbers and ${davi}'s updates.`,
  },
  dashboard: {
    title: "My Growth",
    eyebrow: "Squared Away Growth",
    serif: "your growth,",
    heavy: "in plain numbers.",
    inboxLink: "My inbox",
    paused: `Growth work is paused for now. Call or text ${davi} to pick it back up.`,
    notStarted: (date: string) => `Growth starts on ${date}. Your numbers show up here from then.`,
    since: {
      region: "Since you started",
      serif: "since you started,",
      heavy: (date: string) => `${date}.`,
    },
    month: {
      region: "This month",
      serif: "this month,",
      heavy: (name: string) => `${name}.`,
    },
    updates: {
      region: `Updates from ${davi}`,
      serif: "updates,",
      heavy: `from ${davi}.`,
      empty: `No updates yet. ${davi} posts them here.`,
    },
    services: {
      region: "What we do for you",
      serif: "what we do,",
      heavy: "for you.",
      none: `${davi} adds the services you picked here.`,
    },
    talk: {
      region: `Talk to ${davi}`,
      serif: "questions?",
      heavy: `call or text ${davi.toLowerCase()}.`,
      call: `Call ${phone}`,
      text: `Text ${phone}`,
    },
    account: "Account and sign out",
  },
} as const;
