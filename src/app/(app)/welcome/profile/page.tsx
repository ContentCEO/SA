import { BusinessProfileForm } from "@/components/forms/business-profile-form";
import { Headline } from "@/components/brand/headline";
import { profileDefaults } from "@/server/profile-defaults";
import { requireOwner } from "@/server/session";

export default async function WelcomeProfilePage() {
  const { workspace } = await requireOwner();
  return (
    <>
      <p className="text-sm font-semibold">Step 2 of 3</p>
      <Headline serif="Gmail's connected," heavy="tell us about the shop." />
      <p className="text-lg text-muted-foreground">
        Two minutes. You can change any of this later in Settings. Only the first three are
        required.
      </p>
      <BusinessProfileForm
        defaults={await profileDefaults(workspace)}
        returnTo="/welcome/learning"
        submitLabel="Save and continue"
      />
    </>
  );
}
