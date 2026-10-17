"use client";

import { useEffect, type RefObject } from "react";
import { clearKept, readKept, writeKept } from "@/lib/kept-text";

type Fields = Record<string, string | string[]>;

/** The form's own fields (not hidden ones or buttons), by name. Checkboxes as a list. */
function readFields(form: HTMLFormElement): Fields {
  const out: Fields = {};
  for (const el of Array.from(form.elements)) {
    if (!(
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ))
      continue;
    if (!el.name || el.type === "hidden" || el.type === "submit" || el.type === "button") continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") {
      const list = (out[el.name] as string[] | undefined) ?? [];
      if (el.checked) list.push(el.value);
      out[el.name] = list;
    } else out[el.name] = el.value;
  }
  return out;
}

function fill(form: HTMLFormElement, fields: Fields) {
  for (const el of Array.from(form.elements)) {
    if (!(
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      el instanceof HTMLSelectElement
    ))
      continue;
    if (!el.name || !(el.name in fields) || el.type === "hidden") continue;
    const v = fields[el.name]!;
    if (el instanceof HTMLInputElement && el.type === "checkbox")
      el.checked = Array.isArray(v) && v.includes(el.value);
    else if (typeof v === "string") el.value = v;
  }
}

/**
 * Check 8 P1: keep what's typed in a form across a failed save or a reload, in this tab only.
 * `fingerprint` describes what the server had when the form was shown (its saved values): once
 * a save goes through, it changes and the old copy is dropped instead of restored.
 */
export function useKeptForm(
  ref: RefObject<HTMLFormElement | null>,
  key: string,
  fingerprint: string,
) {
  useEffect(() => {
    const form = ref.current;
    if (!form) return;
    const kept = readKept(key, fingerprint);
    if (kept) {
      try {
        fill(form, JSON.parse(kept) as Fields);
      } catch {
        clearKept(key);
      }
    }
    const save = () => writeKept(key, fingerprint, JSON.stringify(readFields(form)));
    form.addEventListener("input", save);
    form.addEventListener("change", save);
    return () => {
      form.removeEventListener("input", save);
      form.removeEventListener("change", save);
    };
  }, [ref, key, fingerprint]);
}
