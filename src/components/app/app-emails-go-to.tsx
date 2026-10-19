import { appEmailsGoTo } from "@/server/app-emails-to-rules";

/** Check 42 P6: one muted line (two when the sign-in isn't a connected inbox). */
export function AppEmailsGoTo({
  kind,
  signInEmail,
  connectedEmails,
  className,
}: {
  kind: "digest" | "access";
  signInEmail: string | null | undefined;
  connectedEmails: readonly string[];
  className?: string;
}) {
  if (!signInEmail) return null;
  return (
    <p data-app-emails-go-to={kind} className={className ?? "text-muted-foreground"}>
      {appEmailsGoTo(kind, signInEmail, connectedEmails).map((line, i) => (
        <span key={i} className="block break-all">
          {line}
        </span>
      ))}
    </p>
  );
}
