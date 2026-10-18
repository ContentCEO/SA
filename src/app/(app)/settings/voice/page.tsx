import type { Metadata } from "next";
import { Headline } from "@/components/brand/headline";
import { VoiceForm } from "@/components/forms/voice-form";
import { getVoiceProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";

// Check 32 P6: every screen has its own title ("… · Squared Away" from the root template).
export const metadata: Metadata = { title: "How you write" };

export default async function EditVoicePage() {
  const { workspace } = await requireOwner();
  const v = await getVoiceProfile(workspace.id);
  return (
    <>
      <Headline serif="how you write," heavy="in your words." />
      <p className="text-lg text-muted-foreground">
        Fix anything we got wrong. Once you save, the weekly refresh leaves your changes alone.
      </p>
      <VoiceForm
        defaults={{
          greetingStyle: v?.greetingStyle ?? null,
          signoffStyle: v?.signoffStyle ?? null,
          formality: v?.formality ?? null,
          avgLengthWords: v?.avgLengthWords ?? null,
          phrasesUsed: v?.phrasesUsed ?? [],
          phrasesAvoided: v?.phrasesAvoided ?? [],
          summary: v?.summary ?? null,
        }}
      />
    </>
  );
}
