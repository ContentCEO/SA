import type { Metadata } from "next";
import { LegalPage, loadLegalDoc } from "@/components/marketing/legal-page";

export const metadata: Metadata = {
  title: { absolute: "Privacy Policy — Squared Away" },
  description:
    "What Squared Away reads in your Gmail, why, where it goes, how long it's kept, and how to delete it.",
  alternates: { canonical: "/privacy" },
};

export default async function PrivacyPage() {
  return (
    <LegalPage
      source={await loadLegalDoc("privacy-policy.md")}
      serif="the fine print,"
      heavy="privacy policy."
    />
  );
}
