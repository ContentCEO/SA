"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A settings form whose switches save themselves (outside review, I4). It's a normal server
 * action form: before the page's script runs, or without it, the Save button shows and works.
 * Once it runs, ticking a checkbox or picking a radio submits the form. Anything else (a
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
  const [ready, setReady] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- only true once hydrated
  useEffect(() => setReady(true), []);
  return (
    <form
      ref={form}
      action={action}
      className={className}
      data-autosave={ready && hideButton ? "" : undefined}
      onChange={(e) => {
        const t = e.target as unknown as HTMLInputElement;
        if (t.type === "checkbox" || t.type === "radio") form.current?.requestSubmit();
      }}
    >
      {children}
    </form>
  );
}
