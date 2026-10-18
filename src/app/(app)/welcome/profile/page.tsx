import type { Metadata } from "next";
import { BusinessProfileForm } from "@/components/forms/business-profile-form";
import { Headline } from "@/components/brand/headline";
import { profileDefaults } from "@/server/profile-defaults";
import { requireOwner } from "@/server/session";

// Check 32 P6: every screen has its own title ("… · Squared Away" from the root template).
export const metadata: Metadata = { title: "Tell us about the shop" };

export default async function WelcomeProfilePage() {
  const { workspace } = await requireOwner();
  return (
    <>
      <p className="text-sm font-semibold">Step 2 of 3</p>
      <Headline serif="Gmail's connected," heavy="tell us about the shop." />
      <p className="text-lg text-muted-foreground">
        Three questions, marked required. Everything else is optional: add it now under More
        details, or later in Settings.
      </p>
      <BusinessProfileForm
        defaults={await profileDefaults(workspace)}
        returnTo="/welcome/learning"
        submitLabel="Save and continue"
        setup
      />
    </>
  );
}
