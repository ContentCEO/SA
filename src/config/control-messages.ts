import { categoryLabels } from "./categories";
import { RULE_REFUSALS } from "@/server/owner-sender-rule-rules";

/**
 * Ideas H3/H4: the notices after "Move it" and "Save rule", on the Inbox and the Queue (both
 * screens carry the sheets). Codes are fixed; nothing the owner typed goes in a URL.
 */
export const CONTROL_DONE: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(categoryLabels).map(([c, label]) => [`moved_${c}`, `Moved to ${label}.`]),
  ),
  rule_saved: "Rule saved. It applies to new email from now on.",
  vip_added: "Added to your VIPs.",
};

export const CONTROL_ERRORS: Record<string, string> = {
  ...Object.fromEntries(Object.entries(RULE_REFUSALS).map(([k, v]) => [`rule_${k}`, v])),
  resort_sending: "This reply is set to send. Tap Undo first.",
};
