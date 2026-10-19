"use client";

import { useEffect, useRef, useState } from "react";
import { rememberControl } from "@/lib/focus-after-save";
import { isPointerChange } from "./auto-save-rules";

/**
 * A settings form whose switches save themselves (outside review, I4). It's a normal server
 * action form: before the page's script runs, or without it, the Save button shows and works.
 * Once it runs, ticking a checkbox or tapping a radio submits the form (a radio moved with the
 * arrow keys doesn't: the Save button comes back instead). Anything else (a
 * select, a text box) still waits for the button: submitting a select as it changes would move
 * keyboard users on before they've chosen (WCAG 3.2.2), so forms with one keep the button.
 */
export function AutoSaveForm({
  action,
  hideButton = false,
  className,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>;
  /** True when every field is a checkbox or radio, so the button isn't needed once JS runs. */
  hideButton?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const form = useRef<HTMLFormElement>(null);
  const lastPointer = useRef(0);
  const [ready, setReady] = useState(false);
  // Once a radio is moved with the keyboard, the Save button comes back for good.
  const [keyboard, setKeyboard] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- only true once hydrated
  useEffect(() => setReady(true), []);
  return (
    <form
      ref={form}
      action={action}
      className={className}
      data-autosave={ready && hideButton && !keyboard ? "" : undefined}
      onPointerDown={() => {
        lastPointer.current = Date.now();
      }}
      onChange={(e) => {
        const t = e.target as unknown as HTMLInputElement;
        // A checkbox flips on one deliberate tap or Space press: save it. Check 32 P5: note the
        // switch first, so focus comes back to it once the saved screen is back.
        if (t.type === "checkbox") {
          rememberControl(t);
          return form.current?.requestSubmit();
        }
        if (t.type !== "radio") return;
        // Arrow keys move a radio group's choice and fire `change` at every step; saving then
        // would reload the page mid-choice (WCAG 3.2.2). Only a tap or click saves at once;
        // a keyboard change waits for the Save button, which shows again.
        if (isPointerChange(lastPointer.current, Date.now())) {
          rememberControl(t);
          form.current?.requestSubmit();
        } else setKeyboard(true);
      }}
    >
      {children}
    </form>
  );
}
