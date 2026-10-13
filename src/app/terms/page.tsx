import type { Metadata } from "next";
import { LegalPage, loadLegalDoc } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: "Terms of Service — Squared Away",
  description: "The terms for using Squared Away.",
  alternates: { canonical: "/terms" },
};

export default async function TermsPage() {
  return <LegalPage source={await loadLegalDoc("terms.md")} />;
}
