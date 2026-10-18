"use client";

import { useActionState, useState } from "react";
import { saveVoiceAction, type FormState } from "@/app/(app)/settings/profile-actions";
import { CancelLink } from "@/components/app/back-link";
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
  // Check 24 P11: "I don't use one" clears the box and saves no greeting / no sign-off.
  const [greeting, setGreeting] = useState(String(v("greetingStyle", defaults.greetingStyle)));
  const [signoff, setSignoff] = useState(String(v("signoffStyle", defaults.signoffStyle)));
  const [noGreeting, setNoGreeting] = useState(state.values?.noGreeting === "on");
  const [noSignoff, setNoSignoff] = useState(state.values?.noSignoff === "on");
  const noneBox = (
    what: string,
    name: string,
    checked: boolean,
    set: (on: boolean) => void,
    clear: () => void,
  ) => (
    <label className="-mt-4 flex min-h-tap items-center gap-3">
      <input
        type="checkbox"
        name={name}
        value="on"
        checked={checked}
        onChange={(ev) => {
          set(ev.target.checked);
          if (ev.target.checked) clear();
        }}
        className="size-5 shrink-0"
      />
      <span>
        I don&apos;t use one<span className="sr-only"> ({what})</span>
      </span>
    </label>
  );

  return (
    <form ref={formRef} action={action} className="flex flex-col gap-6" noValidate>
      {state.errors ? (
        <p role="alert" className="sa-inverted rounded-lg px-4 py-3 font-semibold">
          A couple of things need fixing below.
        </p>
      ) : null}
      <TextField
        name="greetingStyle"
        label="How do you usually open?"
        hint="Exactly as you type it — “Hey”, “Hi [name],”."
        value={greeting}
        onValueChange={setGreeting}
        disabled={noGreeting}
        error={e.greetingStyle}
      />
      {noneBox("no greeting", "noGreeting", noGreeting, setNoGreeting, () => setGreeting(""))}
      <TextField
        name="signoffStyle"
        label="How do you usually sign off?"
        hint="“Thanks, Davi”, “– D”."
        value={signoff}
        onValueChange={setSignoff}
        disabled={noSignoff}
        error={e.signoffStyle}
      />
      {noneBox("no sign-off", "noSignoff", noSignoff, setNoSignoff, () => setSignoff(""))}
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
        label="Words that don't sound like you"
        hint="Drafts avoid these and flag them. A re-learn can change this list. For words that must never appear, use Never say this on the Your voice screen."
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
      <CancelLink href="/settings/writing" />
    </form>
  );
}
