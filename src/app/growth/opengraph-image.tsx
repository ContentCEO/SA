import { growthCopy } from "@/components/marketing/growth/growth-copy";
import { SHARE_SIZE, shareCard } from "../_og/share-card";

/** /growth's own share card: Growth's words, not the app's "your inbox, handled." */
export const alt = `Squared Away Growth — ${growthCopy.opener.serif} ${growthCopy.opener.heavy}`;
export const size = SHARE_SIZE;
export const contentType = "image/png";

export default function GrowthOpengraphImage() {
  return shareCard({
    serif: growthCopy.opener.serif,
    heavy: growthCopy.opener.heavy,
    heavySize: 136,
    line: "Squared Away Growth: ads, reviews and your website, one-on-one. For anyone in the trades.",
  });
}
