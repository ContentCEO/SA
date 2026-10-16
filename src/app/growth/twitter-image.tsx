import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { SHARE_SIZE } from "../_og/share-card";
import GrowthOpengraphImage from "./opengraph-image";

/** The same card as /growth's opengraph-image, for X / Twitter. */
export const alt = `Squared Away Growth — ${growthCopy.opener.serif} ${growthCopy.opener.heavy}`;
export const size = SHARE_SIZE;
export const contentType = "image/png";

export default function GrowthTwitterImage() {
  return GrowthOpengraphImage();
}
