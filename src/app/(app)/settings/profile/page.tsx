import { BusinessProfileForm } from "@/components/forms/business-profile-form";
import { Headline } from "@/components/brand/headline";
import { BackLink } from "@/components/app/back-link";
import { profileDefaults } from "@/server/profile-defaults";
import { requireOwner } from "@/server/session";

export default async function EditProfilePage() {
  const { workspace } = await requireOwner();
  return (
    <>
      <div className="flex flex-col gap-2">
        <BackLink href="/settings/business">Your business</BackLink>
        <Headline serif="about your shop," heavy="the basics." />
      </div>
      <p className="text-lg text-muted-foreground">
        Drafts use this to answer the way you would. Anything left blank, they&apos;ll ask the
        customer about or leave for you to fill in.
      </p>
      <BusinessProfileForm
        defaults={await profileDefaults(workspace)}
        returnTo="/settings/business?done=profile"
        submitLabel="Save business profile"
        cancelHref="/settings/business"
      />
    </>
  );
}
