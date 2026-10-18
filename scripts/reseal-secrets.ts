/**
 * Check 26 P7: pnpm reseal:secrets — after replacing TOKEN_ENCRYPTION_KEY (the old key set as
 * TOKEN_ENCRYPTION_KEY_PREVIOUS), re-seal every stored secret with the new key. Prints counts
 * only. Safe to re-run. Steps: docs/SETUP.md, "Replacing the encryption key".
 */
import { resealSecrets } from "../src/server/reseal-secrets";

async function main() {
  const { mailboxes, settings } = await resealSecrets();
  console.log(
    `Gmail tokens: ${mailboxes.resealed} re-sealed, ${mailboxes.current} already on the new key, ${mailboxes.unreadable} unreadable.`,
  );
  console.log(
    `Saved secrets: ${settings.resealed} re-sealed, ${settings.current} already on the new key, ${settings.unreadable} unreadable.`,
  );
  if (mailboxes.unreadable || settings.unreadable) {
    console.log(
      "Some secrets open with neither key. Keep TOKEN_ENCRYPTION_KEY_PREVIOUS set until you know why.",
    );
    process.exit(2);
  }
  process.exit(0);
}

main().catch((err) => {
  // The error's name only: a message could quote something it shouldn't.
  console.error("reseal_failed", err instanceof Error ? err.name : "unknown");
  process.exit(1);
});
