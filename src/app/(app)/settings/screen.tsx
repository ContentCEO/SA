import { BackLink } from "@/components/app/back-link";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { SCREEN_MESSAGES, type SettingsScreenPath } from "./messages";

type Params = Record<string, string | string[] | undefined>;

/**
 * A notice's {name} counts, from the address (Check 15 P5). Only small whole numbers are used;
 * anything else reads as a plain "Saved." so typed text can never show up here.
 */
export function fillCounts(message: string | undefined, params: Params): string | undefined {
  if (!message || !message.includes("{")) return message;
  let ok = true;
  const filled = message.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = params[k];
    if (typeof v === "string" && /^\d{1,4}$/.test(v)) return v;
    ok = false;
    return "";
  });
  return ok ? filled : "Saved.";
}

/** One Settings screen: a way back to the list, its heading, and its own notices. */
export function SettingsScreen({
  path,
  heavy,
  params,
  errorText,
  children,
}: {
  path: SettingsScreenPath;
  heavy: string;
  params: Params;
  /** Words for this visit's `?error=` when they depend on the account (else the map's). */
  errorText?: string;
  children: React.ReactNode;
}) {
  const messages = SCREEN_MESSAGES[path] as {
    done: Record<string, string>;
    error: Record<string, string>;
  };
  const done =
    typeof params.done === "string" ? fillCounts(messages.done[params.done], params) : undefined;
  const error =
    errorText ?? (typeof params.error === "string" ? messages.error[params.error] : undefined);
  return (
    <>
      <div className="flex flex-col gap-2">
        <BackLink href="/settings">Settings</BackLink>
        <Headline serif="settings," heavy={heavy} />
      </div>
      {done ? <Notice>{done}</Notice> : null}
      {error ? <Notice strong>{error}</Notice> : null}
      {children}
    </>
  );
}
