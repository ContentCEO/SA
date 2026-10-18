"use client";

import { createContext, useContext } from "react";
import { siteConfig } from "@/config/site";
import { phoneHref } from "@/lib/phone-href";

/**
 * Check 32 P12: how to reach us, on the crash and not-found pages — the same phone and
 * SUPPORT_EMAIL, in the same order, as SiteFooter. The crash page is a client component that
 * can't read SUPPORT_EMAIL, so the root layout hands it down through this context.
 */
const SupportEmail = createContext<string | undefined>(undefined);

export function SupportEmailProvider({
  email,
  children,
}: {
  email: string | undefined;
  children?: React.ReactNode;
}) {
  return <SupportEmail.Provider value={email || undefined}>{children}</SupportEmail.Provider>;
}

const link = "inline-flex min-h-tap items-center underline underline-offset-4";

export function HelpLine({ email }: { email?: string }) {
  const fromLayout = useContext(SupportEmail);
  const support = email ?? fromLayout;
  return (
    <p className="text-muted-foreground">
      Stuck? Call{" "}
      <a href={phoneHref("tel", siteConfig.phone)} className={link}>
        {siteConfig.phone}
      </a>
      {support ? (
        <>
          {" "}
          or email{" "}
          <a href={`mailto:${support}`} className={link}>
            {support}
          </a>
        </>
      ) : null}
      .
    </p>
  );
}
