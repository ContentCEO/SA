import { BackLink } from "@/components/app/back-link";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { SCREEN_MESSAGES, type SettingsScreenPath } from "./messages";

type Params = Record<string, string | string[] | undefined>;

/** One Settings screen: a way back to the list, its heading, and its own notices. */
export function SettingsScreen({
  path,
  heavy,
  params,
  children,
}: {
  path: SettingsScreenPath;
  heavy: string;
  params: Params;
  children: React.ReactNode;
}) {
  const messages = SCREEN_MESSAGES[path] as {
    done: Record<string, string>;
    error: Record<string, string>;
  };
  const done = typeof params.done === "string" ? messages.done[params.done] : undefined;
  const error = typeof params.error === "string" ? messages.error[params.error] : undefined;
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
