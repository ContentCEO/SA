import type { Metadata } from "next";
import { LegalPage, loadLegalDoc } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: { absolute: "Terms of Service — Squared Away" },
  // Check 33 P6: long enough to show in a search result (50 to 160 characters).
  description:
    "The terms for using Squared Away: your three-day trial, the setup fee and monthly plan, what it does with your Gmail, and how to cancel or delete your account.",
  alternates: { canonical: "/terms" },
};

export default async function TermsPage() {
  return <LegalPage source={await loadLegalDoc("terms.md")} />;
}
