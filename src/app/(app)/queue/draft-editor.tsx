"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";
import { addNeverSayAction } from "../settings/wording-actions";
import { editorAction, sendDraftAction, type EditorState } from "./actions";

function Pending({
  label,
  busy,
  ...props
}: { label: string; busy: string } & React.ComponentProps<typeof Button>) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} {...props}>
      {pending ? busy : label}
    </Button>
  );
}

const START: EditorState = { message: null, latest: null, typed: null };

/**
 * The Edit box on a draft card. Save changes goes through `editorAction`, which answers in the
 * card instead of leaving it: when the reply changed while it was open (in Gmail, or on another
 * device — Check 42 P2), the newest text comes back to edit and what the person typed stays in
 * "Your text" below, so nothing typed is lost.
 */
export function DraftEditor(p: {
  draftId: string;
  /** The text the editor opens with (gaps the owner filled on the card included). */
  body: string;
  /** bodyHash of the draft's stored text when the card was shown. */
  seenHash: string;
  toLine: React.ReactNode;
  toAddress: string;
  canSend: boolean;
  onCancel: () => void;
}) {
  const [state, formAction] = useActionState(editorAction, START);
  const [text, setText] = useState(p.body);
  // When the reply changed under the editor, the newest text replaces what's in the box (the
  // typed text is shown below). Derived during render, the React way, not in an effect.
  const [shownLatest, setShownLatest] = useState(state.latest);
  if (state.latest !== shownLatest) {
    setShownLatest(state.latest);
    if (state.latest) setText(state.latest.body);
  }
  const opened = state.latest?.hash ?? p.seenHash;

  const editor = useRef<HTMLTextAreaElement>(null);
  const [neverSayNote, setNeverSayNote] = useState<string | null>(null);
  const [savingPhrase, startSaving] = useTransition();
  const neverSay = () => {
    const el = editor.current;
    const phrase = el ? el.value.slice(el.selectionStart, el.selectionEnd).trim() : "";
    if (!phrase) {
      setNeverSayNote("Select the words first — press and hold, then drag.");
      return;
    }
    startSaving(async () => setNeverSayNote((await addNeverSayAction(phrase)).message));
  };

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="draftId" value={p.draftId} />
      <input type="hidden" name="opened" value={opened} />
      <input type="hidden" name="seen" value={opened} />
      {p.toAddress ? <input type="hidden" name="seenTo" value={p.toAddress} /> : null}
      {p.toLine}
      {state.message ? (
        <p role="alert" className="sa-inverted rounded-lg px-3 py-2 font-semibold">
          {state.message}
        </p>
      ) : null}
      <label className="flex flex-col gap-1.5">
        <span className="font-semibold">Your reply</span>
        <textarea
          ref={editor}
          name="body"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          autoFocus
          className="w-full rounded-lg border border-input bg-paper px-3 py-2.5 text-base"
        />
      </label>
      {state.typed !== null && state.latest ? (
        <label className="flex flex-col gap-1.5">
          <span className="font-semibold">Your text</span>
          <span className="text-sm text-muted-foreground">
            What you typed before it changed. Copy what you need into the reply above.
          </span>
          <textarea
            readOnly
            value={state.typed}
            rows={6}
            className="w-full rounded-lg border border-input bg-card px-3 py-2.5 text-base"
          />
        </label>
      ) : null}
      {p.canSend ? (
        <Pending
          formAction={sendDraftAction}
          label="Send reply"
          busy="Sending…"
          size="lg"
          className="w-full"
        />
      ) : null}
      <Pending label="Save changes" busy="Saving…" variant="outline" className="w-full" />
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={savingPhrase}
        onClick={neverSay}
      >
        {savingPhrase ? "Adding…" : "Never say this"}
      </Button>
      {neverSayNote ? (
        <p role="status" className="text-sm font-semibold">
          {neverSayNote}
        </p>
      ) : null}
      <Button type="button" variant="ghost" className="w-full" onClick={p.onCancel}>
        Cancel
      </Button>
    </form>
  );
}
