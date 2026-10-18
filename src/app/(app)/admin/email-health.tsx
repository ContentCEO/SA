import { Notice } from "@/components/app/notice";
import { PendingButton } from "@/components/app/pending-button";
import type { EmailHealth } from "@/server/email-health-rules";

/**
 * Check 18 P2: "Email" — can the app's own emails reach owners? Two-tone: the test sender inverts
 * because it blocks every owner but Davi. Shows the sender's state, the week's refusal count and
 * a test button. No owner address appears here; the sender address is the app's own.
 */
export function EmailHealthBox({
  health,
  refused,
  done,
  error,
  sendTestAction,
}: {
  health: EmailHealth;
  refused: string;
  done?: string;
  error?: string;
  sendTestAction: () => Promise<void>;
}) {
  const inverted = health.state === "test_sender";
  return (
    <section
      id="email"
      aria-labelledby="email-heading"
      className={
        inverted
          ? "sa-inverted flex flex-col gap-2 rounded-xl p-4"
          : "flex flex-col gap-2 rounded-xl border-2 border-charcoal p-4"
      }
    >
      <h2 id="email-heading" className="text-lg font-black">
        Email
      </h2>
      <p className={health.state === "real" ? "" : "font-semibold"}>{health.line}</p>
      <p>{refused}</p>
      {done ? <Notice>{done}</Notice> : null}
      {error ? <Notice strong={!inverted}>{error}</Notice> : null}
      <form action={sendTestAction}>
        <PendingButton pending="Sending…" variant="outline" className="w-full">
          Send me a test email
        </PendingButton>
      </form>
    </section>
  );
}
