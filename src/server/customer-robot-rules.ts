/**
 * Check 13 P2: a sender that is a machine, never a customer — pure rules, with the SQL twin
 * `customerRobotSql` in thread-sql.ts (parity-tested on one table of addresses). Takes the
 * address a reply goes to (a website form's stored Reply-To, else the sender), so a form lead
 * with a usable Reply-To is the person, and a form robot with none is a robot.
 */
import { LEAD_RELAY_LOCAL_PATTERN } from "@/config/lead-sources";
import { isReceiptSender } from "./money-rules";
import { leadPlatformOf } from "./monthly-rules";
import { looksLikeFormSender } from "./reply-address-rules";
import { isNoReplyAddress } from "./sender-rules";

const LEAD_RELAY_LOCAL = new RegExp(LEAD_RELAY_LOCAL_PATTERN);

/**
 * A lead platform's per-customer relay (reply+8x2k@messages.thumbtack.com): a reply there
 * reaches one person, so it is that person on Customers.
 */
export function isLeadRelayAddress(address: string | null | undefined): boolean {
  const s = (address ?? "").trim().toLowerCase();
  const at = s.lastIndexOf("@");
  if (at <= 0) return false;
  return leadPlatformOf(s) !== null && LEAD_RELAY_LOCAL.test(s.slice(0, at));
}

/**
 * A no-reply or job-board sender (`isNoReplyAddress`), a website form's robot
 * (`looksLikeFormSender`: website@, webmaster@, forms@, a form host), a lead platform's own
 * address that isn't a per-customer relay (leads@angi.com), or a payment-receipt sender
 * (`isReceiptSender`: QuickBooks, Stripe).
 */
export function isCustomerRobot(address: string | null | undefined): boolean {
  const s = (address ?? "").trim().toLowerCase();
  if (s.lastIndexOf("@") <= 0) return false;
  return (
    isNoReplyAddress(s) ||
    looksLikeFormSender(s) ||
    (leadPlatformOf(s) !== null && !isLeadRelayAddress(s)) ||
    isReceiptSender(s)
  );
}
