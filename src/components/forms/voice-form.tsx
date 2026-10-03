"use client";

import { useActionState } from "react";
import { saveVoiceAction, type FormState } from "@/app/(app)/settings/profile-actions";
import { Button } from "@/components/ui/button";
import { useFocusFirstError } from "./use-focus-first-error";
import { SelectField, TextArea, TextField } from "./field";

export type VoiceDefaults = {
  greetingStyle: string | null;
  signoffStyle: string | null;
  formality: string | null;
  avgLengthWords: number | null;
  phrasesUsed: string[];
  phrasesAvoided: string[];
  summary: string | null;
};

export function VoiceForm({ defaults }: { defaults: VoiceDefaults }) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveVoiceAction, {});
  const e = state.errors ?? {};
  const formRef = useFocusFirstError(state.errors);
  const v = (k: keyof VoiceDefaults, fallback: string | number | null) =>
    state.values?.[k] ?? fallback ?? "";

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-6" noValidate>
      <TextField
        name="greetingStyle"
        label="How do you usually open?"
        hint="Exactly as you type it — “Hey”, “Hi [name],”."
        defaultValue={v("greetingStyle", defaults.greetingStyle) as string}
        error={e.greetingStyle}
      />
      <TextField
        name="signoffStyle"
        label="How do you usually sign off?"
        hint="“Thanks, Davi”, “– D”."
        defaultValue={v("signoffStyle", defaults.signoffStyle) as string}
        error={e.signoffStyle}
      />
      <SelectField
        name="formality"
        label="How formal are you?"
        options={[
          { value: "casual", label: "Casual" },
          { value: "neutral", label: "Friendly but businesslike" },
          { value: "formal", label: "Formal" },
        ]}
        defaultValue={v("formality", defaults.formality ?? "neutral") as string}
        error={e.formality}
      />
      <TextField
        name="avgLengthWords"
        label="About how many words in a typical reply?"
        inputMode="numeric"
        defaultValue={v("avgLengthWords", defaults.avgLengthWords ?? 60) as string}
        error={e.avgLengthWords}
      />
      <TextArea
        name="phrasesUsed"
        label="Things you say a lot"
        hint="One per line."
        defaultValue={v("phrasesUsed", defaults.phrasesUsed.join("\n")) as string}
        error={e.phrasesUsed}
        rows={4}
      />
      <TextArea
        name="phrasesAvoided"
        label="Things you'd never say"
        hint="One per line. Drafts will steer clear."
        defaultValue={v("phrasesAvoided", defaults.phrasesAvoided.join("\n")) as string}
        error={e.phrasesAvoided}
        rows={4}
      />
      <TextArea
        name="summary"
        label="Anything else about how you write?"
        defaultValue={v("summary", defaults.summary) as string}
        error={e.summary}
        rows={3}
      />
      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? "Saving…" : "Save how I write"}
      </Button>
    </form>
  );
}
