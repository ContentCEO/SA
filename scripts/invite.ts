/**
 * Invite an owner: pnpm invite owner@shop.com plumbing "met at trade show"
 * Trade is one of carpentry | plumbing | electrical | other (optional).
 * Replaced by a button in /admin in Milestone 6.
 */
import { invites, tradeEnum } from "../src/db/schema";
import { db } from "../src/db";

async function main() {
  const [emailArg, tradeArg, ...noteParts] = process.argv.slice(2);
  if (!emailArg || !emailArg.includes("@")) {
    console.error(
      'Usage: pnpm invite owner@shop.com [carpentry|plumbing|electrical|other] ["note"]',
    );
    process.exit(1);
  }
  const trades = tradeEnum.enumValues as readonly string[];
  if (tradeArg && !trades.includes(tradeArg)) {
    console.error(`Trade must be one of: ${trades.join(", ")}`);
    process.exit(1);
  }
  const email = emailArg.trim().toLowerCase();
  await db()
    .insert(invites)
    .values({
      email,
      trade: (tradeArg as (typeof tradeEnum.enumValues)[number] | undefined) ?? null,
      note: noteParts.join(" ") || null,
    })
    .onConflictDoNothing();
  console.log(`Invited ${email}. They can sign in now.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
