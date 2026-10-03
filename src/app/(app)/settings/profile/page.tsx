import { BusinessProfileForm } from "@/components/forms/business-profile-form";
import { Headline } from "@/components/brand/headline";
import { profileDefaults } from "@/server/profile-defaults";
import { requireOwner } from "@/server/session";

export default async function EditProfilePage() {
  const { workspace } = await requireOwner();
  return (
    <>
      <Headline serif="about your shop," heavy="the basics." />
      <p className="text-lg text-muted-foreground">
        Drafts use this to answer the way you would. Anything left blank, they&apos;ll ask the
        customer about or leave for you to fill in.
      </p>
      <BusinessProfileForm
        defaults={await profileDefaults(workspace)}
        returnTo="/settings?done=profile"
        submitLabel="Save business profile"
      />
    </>
  );
}
