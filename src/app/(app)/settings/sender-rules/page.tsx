import type { Metadata } from "next";
import { Button } from "@/components/ui/button";
import { ACTION_WORDS } from "@/server/owner-sender-rule-rules";
import { listRules } from "@/server/sender-rule-store";
import { requireOwner } from "@/server/session";
import { SettingsScreen } from "../screen";
import { removeSenderRuleAction } from "../away-actions";

export const metadata: Metadata = { title: "Sender rules" };

/** Ideas H3: every rule the owner set, each removable. VIPs stay on the VIP list. */
export default async function SenderRulesPage(props: PageProps<"/settings/sender-rules">) {
  const { workspace } = await requireOwner();
  const rules = await listRules(workspace.id);
  return (
    <SettingsScreen
      path="/settings/sender-rules"
      heavy="sender rules."
      params={await props.searchParams}
    >
      {rules.length ? (
        <ul className="flex flex-col gap-2">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-col gap-2 rounded-lg border bg-card p-3">
              <span className="font-semibold break-all">
                {r.scope === "domain" ? `Anyone at ${r.pattern}` : r.pattern}
              </span>
              <span className="text-muted-foreground">{ACTION_WORDS[r.action]}</span>
              <details>
                <summary className="inline-flex min-h-tap cursor-pointer items-center font-semibold underline underline-offset-4">
                  Remove
                </summary>
                <form action={removeSenderRuleAction} className="flex flex-col gap-2 pt-2">
                  <input type="hidden" name="id" value={r.id} />
                  <p>Remove this rule?</p>
                  <Button type="submit" variant="outline" className="w-full">
                    Remove rule
                  </Button>
                </form>
              </details>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-lg">
          No rules yet. Open any email in Inbox and tap Rules for this sender.
        </p>
      )}
    </SettingsScreen>
  );
}
