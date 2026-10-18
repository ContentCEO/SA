import type { Metadata } from "next";
import Link from "next/link";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { openSuggestions } from "@/server/edit-learning";
import { listMailboxes } from "@/server/mailboxes";
import { describeVoice, getBusinessProfile, getVoiceProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import { decideVoiceIdeaAction, relearnVoiceAction } from "../profile-actions";
import { SettingsScreen } from "../screen";
import { saveNeverSayAction } from "../wording-actions";
import { showGaps } from "@/ai/gaps";

export const metadata: Metadata = { title: "Your voice" };

export default async function WritingSettingsPage(props: PageProps<"/settings/writing">) {
  const { workspace } = await requireOwner();
  const [profile, voice, ideas, mailboxes] = await Promise.all([
    getBusinessProfile(workspace.id),
    getVoiceProfile(workspace.id),
    openSuggestions(workspace.id),
    listMailboxes(workspace.id),
  ]);
  const voiceLine =
    voice?.status === "ready"
      ? describeVoice(voice)
      : voice?.status === "learning"
        ? "Reading your sent mail to learn how you write…"
        : voice?.status === "not_enough_mail"
          ? "Not enough sent mail to learn from yet. You can describe it yourself."
          : voice?.status === "failed"
            ? "Couldn't learn your style last time. You can describe it yourself, or try again."
            : "Not learned yet. It starts once your email has been read.";

  return (
    <SettingsScreen path="/settings/writing" heavy="your voice." params={await props.searchParams}>
      <section aria-labelledby="voice" className="flex flex-col gap-3">
        <h2 id="voice" className="text-xl font-black">
          How you write
        </h2>
        <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <p className="text-lg">{voiceLine}</p>
          {voice?.status === "ready" && voice.phrasesUsed.length ? (
            <p className="text-muted-foreground">
              You say things like “{voice.phrasesUsed.slice(0, 3).join("”, “")}”.
            </p>
          ) : null}
          {voice?.status === "ready" && voice.phrasesAvoided.length ? (
            <p className="text-muted-foreground">
              Drafts will never say “{voice.phrasesAvoided.slice(0, 2).join("” or “")}”.
            </p>
          ) : null}
          {voice?.examples.length ? (
            <details>
              <summary className="inline-flex min-h-tap cursor-pointer items-center font-semibold">
                Sample replies in your style
              </summary>
              <ul className="mt-2 flex flex-col gap-3">
                {voice.examples.map((ex, i) => (
                  <li key={i} className="rounded-lg border bg-paper p-3 whitespace-pre-line">
                    {/* Check 23 P7: voice.v3 samples carry {{…}} gaps; show them as plain words. */}
                    {showGaps(ex)}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {voice?.source === "edited" ? (
            <p className="text-sm text-muted-foreground">
              You edited this, so the weekly refresh leaves it alone.
            </p>
          ) : null}
        </div>
        {ideas.length ? (
          <div className="flex flex-col gap-2" aria-label="Ideas from your edits" role="group">
            <p className="font-semibold">Ideas from your edits</p>
            {ideas.map((idea) => (
              <form
                key={idea.id}
                action={decideVoiceIdeaAction}
                className="flex flex-col gap-2 rounded-xl border-2 border-charcoal p-3"
              >
                <input type="hidden" name="ideaId" value={idea.id} />
                <p>{idea.text}</p>
                <div className="grid grid-cols-2 gap-2">
                  <Button type="submit" name="answer" value="yes">
                    {idea.kind === "signoff" || idea.kind === "greeting"
                      ? "Yes, I'll type it"
                      : "Yes, do that"}
                  </Button>
                  <Button type="submit" name="answer" value="no" variant="outline">
                    No thanks
                  </Button>
                </div>
              </form>
            ))}
            <p className="text-sm text-muted-foreground">
              From how you&apos;ve edited drafts this month. Nothing changes unless you say yes.
            </p>
          </div>
        ) : null}
        <Link
          href="/settings/voice"
          className={cn(buttonVariants({ variant: "outline" }), "w-full")}
        >
          Edit how I write
        </Link>
        {mailboxes.some((m) => m.status === "active") ? (
          // It replaces the owner's own edits, so it asks once first (outside review).
          <details className="rounded-lg border">
            <summary className="flex min-h-tap cursor-pointer items-center px-4 font-semibold">
              Re-learn from my sent mail
            </summary>
            <form action={relearnVoiceAction} className="flex flex-col gap-2 px-4 pb-4">
              <p>
                This replaces how you write with what we learn from your sent mail now, including
                any changes you made yourself.
              </p>
              <Button type="submit" className="w-full">
                Yes, re-learn and replace my edits
              </Button>
            </form>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="never-say-heading" className="flex flex-col gap-3">
        <h2 id="never-say-heading" className="text-xl font-black">
          Never say this
        </h2>
        <p className="text-muted-foreground">
          Words and phrases your drafts must never use — one per line. If one slips in, the draft is
          rewritten once, then flagged for you. You can also select words while editing a draft and
          tap Never say this.
        </p>
        <form action={saveNeverSayAction} className="flex flex-col gap-3">
          <textarea
            name="neverSay"
            aria-label="Your never-say list"
            defaultValue={(profile?.neverSay ?? []).join("\n")}
            rows={4}
            placeholder={"No worries\nPer my last email"}
            className="w-full rounded-lg border border-input bg-paper px-3 py-2.5 text-base"
          />
          <Button type="submit" variant="outline" className="w-full">
            Save never-say list
          </Button>
        </form>
      </section>
    </SettingsScreen>
  );
}
