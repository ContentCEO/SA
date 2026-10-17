import "server-only";
import type { ProfileDefaults } from "@/components/forms/business-profile-form";
import type { Workspace } from "@/db/schema";
import { DEFAULT_AMOUNT_THRESHOLD_DOLLARS } from "./classification";
import { getBusinessProfile } from "./profile";
import { suggestTowns } from "./service-area-rules";

export async function profileDefaults(workspace: Workspace): Promise<ProfileDefaults> {
  const p = await getBusinessProfile(workspace.id);
  return {
    businessName: workspace.businessName,
    trade: workspace.trade,
    extraTrades: workspace.extraTrades ?? [],
    services: p?.services ?? null,
    serviceArea: p?.serviceArea ?? null,
    // Leads package (B9): a first suggestion from "Where do you work?" while the list is empty.
    serviceTowns: p?.serviceTowns?.length ? p.serviceTowns : suggestTowns(p?.serviceArea),
    hours: p?.hours ?? null,
    leadTime: p?.leadTime ?? null,
    pricingNotes: p?.pricingNotes ?? null,
    paymentTerms: p?.paymentTerms ?? null,
    policies: p?.policies ?? null,
    signature: p?.signature ?? null,
    reviewUrl: p?.reviewUrl ?? null,
    doNotPromise: p?.doNotPromise ?? [],
    vipSenders: p?.vipSenders ?? [],
    amountThresholdDollars: p?.amountThresholdDollars ?? DEFAULT_AMOUNT_THRESHOLD_DOLLARS,
    licenses: p?.licenses ?? {},
  };
}
