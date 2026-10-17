"use client";

import { useActionState, useRef, useState, useTransition } from "react";
import { useFormStatus } from "react-dom";
import { editorGapsLeft, findGaps, fromEditorText, toEditorText } from "@/ai/gaps";
import { Button } from "@/components/ui/button";
import { clearKept, writeKept } from "@/lib/kept-text";
import { addNeverSayAction } from "../settings/wording-actions";
import { editorAction, type EditorState } from "./actions";
import { SendButton } from "./send-button";

function SaveButton() {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      name="intent"
      value="save"
      variant="outline"
      disabled={pending}
      className="w-full"
    >
      {pending ? "Saving…" : "Save changes"}
    </Button>
  );
}

const START: EditorState = { message: null, latest: null, typed: null };

/** The sessionStorage key for what's typed in a draft's Edit box (Check 8 P1, 9 P4). */
export const keptEditKey = (draftId: string) => `edit:${draftId}`;

/**
 * The Edit box on a draft card. Save changes and Send reply go through `editorAction`, which
 * answers inside the card instead of leaving it (Check 9 P4): a refusal keeps the editor open
 * with the owner's text and says why, and nothing typed is lost. When the reply changed while
 * it was open (in Gmail, or on another device — Check 42 P2), the newest text comes back to
 * edit and what was typed stays in "Your text" below. Gaps read as words ([time]) and turn back
 * into tokens before the text leaves the phone. Typed text is kept in this tab until it's saved
 * or sent (a reload doesn't wipe it).
 */
export function DraftEditor(p: {
  draftId: string;
  /** The draft's text as the card shows it (gaps the owner filled on the card included). */
  body: string;
  /** What this tab kept from an earlier visit, if anything (already checked against seenHash). */
  kept?: string | null;
  /** bodyHash of the draft's stored text when the card was shown. */
  seenHash: string;
  toLine: React.ReactNode;
  toAddress: string;
  canSend: boolean;
  onCancel: () => void;
}) {
  const [state, formAction] = useActionState(editorAction, START);
  const [text, setText] = useState(p.kept ?? toEditorText(p.body));
  // When the reply changed under the editor, the newest text replaces what's in the box (the
  // typed text is shown below). Derived during render, the React way, not in an effect.
  const [shownLatest, setShownLatest] = useState(state.latest);
  if (state.latest !== shownLatest) {
    setShownLatest(state.latest);
    if (state.latest) setText(toEditorText(state.latest.body));
  }
  const original = state.latest?.body ?? p.body;
  const opened = state.latest?.hash ?? p.seenHash;
  const hadGaps = findGaps(original).length > 0;
  const gapsLeft = editorGapsLeft(text, original);
  const change = (value: string) => {
    setText(value);
    writeKept(keptEditKey(p.draftId), opened, value);
  };

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
      {/* What goes to the server: the box's text with [time]-style gaps back as tokens. */}
      <input type="hidden" name="body" value={fromEditorText(text, original)} />
      {p.toLine}
      {state.message ? (
        <p role="alert" className="sa-inverted rounded-lg px-3 py-2 font-semibold">
          {state.message}
        </p>
      ) : null}
      {hadGaps ? <p className="font-semibold">Replace each [ ] before sending.</p> : null}
      <label className="flex flex-col gap-1.5">
        <span className="font-semibold">Your reply</span>
        <textarea
          ref={editor}
          value={text}
          onChange={(e) => change(e.target.value)}
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
            value={toEditorText(state.typed)}
            rows={6}
            className="w-full rounded-lg border border-input bg-card px-3 py-2.5 text-base"
          />
        </label>
      ) : null}
      {p.canSend ? (
        gapsLeft.length ? (
          <div
            role="note"
            className="flex min-h-12 items-center justify-center rounded-lg border-2 border-charcoal px-4 text-center font-black"
          >
            Fill in {gapsLeft.join(", ")} first
          </div>
        ) : (
          <SendButton name="intent" value="send" />
        )
      ) : null}
      <SaveButton />
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
      <Button
        type="button"
        variant="ghost"
        className="w-full"
        onClick={() => {
          clearKept(keptEditKey(p.draftId));
          p.onCancel();
        }}
      >
        Cancel
      </Button>
    </form>
  );
}
