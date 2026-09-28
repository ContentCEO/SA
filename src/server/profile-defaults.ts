import "server-only";
import type { ProfileDefaults } from "@/components/forms/business-profile-form";
import type { Workspace } from "@/db/schema";
import { DEFAULT_AMOUNT_THRESHOLD_DOLLARS } from "./classification";
import { getBusinessProfile } from "./profile";

export async function profileDefaults(workspace: Workspace): Promise<ProfileDefaults> {
  const p = await getBusinessProfile(workspace.id);
  return {
    businessName: workspace.businessName,
    trade: workspace.trade,
    services: p?.services ?? null,
    serviceArea: p?.serviceArea ?? null,
    hours: p?.hours ?? null,
    leadTime: p?.leadTime ?? null,
    pricingNotes: p?.pricingNotes ?? null,
    paymentTerms: p?.paymentTerms ?? null,
    policies: p?.policies ?? null,
    signature: p?.signature ?? null,
    doNotPromise: p?.doNotPromise ?? [],
    vipSenders: p?.vipSenders ?? [],
    amountThresholdDollars: p?.amountThresholdDollars ?? DEFAULT_AMOUNT_THRESHOLD_DOLLARS,
  };
}
