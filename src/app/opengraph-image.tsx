import { SHARE_SIZE, shareCard } from "./_og/share-card";

/** The share card for links to the site: the "your inbox, handled." headline in the brand. */
export const alt = "Squared Away — your inbox, handled.";
export const size = SHARE_SIZE;
export const contentType = "image/png";

export default function OpengraphImage() {
  return shareCard({
    serif: "your inbox,",
    heavy: "handled.",
    line: "Built for carpenters, plumbers, and electricians. Nothing goes out without your okay.",
  });
}
