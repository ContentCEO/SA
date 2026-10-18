/**
 * Check 15 P4: every saved business profile fact, in the order the owner looks for them, for
 * Settings → Your business. Pure (no `server-only`, no database). Each row names the form field
 * its "Change" link lands on (/settings/profile#<field>).
 */
import { licenseFacts, type Licenses } from "@/config/licenses";
import { isTrade, tradeLabel } from "@/config/trades";
import { US_STATES } from "@/config/us-states";

export type ProfileFactRow = {
  label: string;
  /** The form field the Change link lands on. */
  field: string;
  /** The saved value as shown, or null when it's not set. */
  value: string | null;
  /** When not set: one line on what that means. */
  emptyNote: string;
};

export type ProfileFactsInput = {
  pricingNotes?: string | null;
  leadTime?: string | null;
  hours?: string | null;
  services?: string | null;
  serviceArea?: string | null;
  paymentTerms?: string | null;
  policies?: string | null;
  signature?: string | null;
  doNotPromise?: string[] | null;
  vipSenders?: string[] | null;
  amountThresholdDollars?: number | null;
  reviewUrl?: string | null;
  licenses?: Licenses | null;
  state?: string | null;
};

export type ProfileFactsWorkspace = {
  businessName?: string | null;
  extraTrades?: readonly string[] | null;
};

const PRICE_LINES_SHOWN = 3;

/** The price list's lines, trimmed, blanks dropped. */
export function priceListLines(pricingNotes: string | null | undefined): string[] {
  return (pricingNotes ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** "Service call $129 · Drain clearing from $189 · … and 7 more" */
function priceListValue(pricingNotes: string | null | undefined): string | null {
  const list = priceListLines(pricingNotes);
  if (!list.length) return null;
  const shown = list.slice(0, PRICE_LINES_SHOWN).join("\n");
  const more = list.length - PRICE_LINES_SHOWN;
  return more > 0 ? `${shown}\nand ${more} more` : shown;
}

const text = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

export function describeProfileFacts(
  profile: ProfileFactsInput | null | undefined,
  workspace: ProfileFactsWorkspace,
): ProfileFactRow[] {
  const p = profile ?? {};
  const extras = (workspace.extraTrades ?? []).filter(isTrade).map((t) => tradeLabel[t]);
  const state = p.state ? (US_STATES.find(([c]) => c === p.state)?.[1] ?? p.state) : null;
  return [
    {
      label: "Price list",
      field: "pricingNotes",
      value: priceListValue(p.pricingNotes),
      emptyNote: "Not set. Drafts never give a price.",
    },
    {
      label: "Booking out",
      field: "leadTime",
      value: text(p.leadTime),
      emptyNote: "Not set. Drafts won't say how soon you can start.",
    },
    {
      label: "Hours",
      field: "hours",
      value: text(p.hours),
      emptyNote: "Not set. Drafts won't say when you work.",
    },
    {
      label: "Work",
      field: "services",
      value: text(p.services),
      emptyNote: "Not set. Drafts can't say what work you take on.",
    },
    {
      label: "Area",
      field: "serviceArea",
      value: text(p.serviceArea),
      emptyNote: "Not set. Drafts won't say where you work.",
    },
    {
      label: "Other trades",
      field: "extraTrades",
      value: extras.length ? extras.join(", ") : null,
      emptyNote: "Not set. Drafts use your main trade's words only.",
    },
    {
      label: "How you get paid",
      field: "paymentTerms",
      value: text(p.paymentTerms),
      emptyNote: "Not set. Drafts won't mention deposits or how to pay.",
    },
    {
      label: "Customers should know",
      field: "policies",
      value: text(p.policies),
      emptyNote: "Not set. Drafts won't mention permits, warranty or cleanup.",
    },
    {
      label: "Signature",
      field: "signature",
      value: text(p.signature),
      emptyNote: "Not set. Drafts end with your sign-off only.",
    },
    {
      label: "Never promise",
      field: "doNotPromise",
      value: p.doNotPromise?.length ? p.doNotPromise.join(" · ") : null,
      emptyNote: "Not set. No extra promises are checked for.",
    },
    {
      label: "People who always need you",
      field: "vipSenders",
      value: p.vipSenders?.length ? p.vipSenders.join(", ") : null,
      emptyNote: "Not set. Only the usual rules send emails to you.",
    },
    {
      label: "Send me anything over",
      field: "amountThresholdDollars",
      value:
        typeof p.amountThresholdDollars === "number"
          ? `$${p.amountThresholdDollars.toLocaleString("en-US")}`
          : null,
      emptyNote: "Not set. Emails over $2,500 come to you.",
    },
    {
      label: "Business",
      field: "businessName",
      value: text(workspace.businessName),
      emptyNote: "Not set. Drafts won't name your business.",
    },
    {
      label: "State",
      field: "state",
      value: state,
      emptyNote: "Not set. No state rules are checked.",
    },
    {
      label: "Review link",
      field: "reviewUrl",
      value: text(p.reviewUrl),
      emptyNote: "Not set. Ask for a review stays off.",
    },
    {
      label: "Licenses",
      field: "hicNumber",
      value: licenseFacts(p.licenses),
      emptyNote: "Not set. Drafts never give a license number.",
    },
  ];
}

/** The Settings list line's price list part (Check 15 P4). */
export function priceListSummary(pricingNotes: string | null | undefined): string {
  const n = priceListLines(pricingNotes).length;
  return n ? `Price list: ${n} line${n === 1 ? "" : "s"}` : "No price list yet";
}
