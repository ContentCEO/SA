"use client";

import { useEffect, useRef } from "react";

/**
 * After a failed save, move the owner to the first field that needs fixing.
 * On a phone the error summary is off-screen, so without this it looks like nothing happened.
 */
export function useFocusFirstError(errors: Record<string, string[]> | undefined) {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (!errors) return;
    const first = ref.current?.querySelector<HTMLElement>("[aria-invalid='true']");
    first?.focus();
    first?.scrollIntoView({ block: "center" });
  }, [errors]);
  return ref;
}
