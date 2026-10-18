import { cn } from "@/lib/utils";

const control =
  "w-full rounded-lg border border-input bg-paper px-3 py-2.5 text-base text-foreground placeholder:text-slate focus-visible:outline-2 focus-visible:outline-ring aria-invalid:border-charcoal aria-invalid:border-2";

type Common = {
  name: string;
  label: string;
  hint?: string;
  error?: string[];
  className?: string;
  /** Marks the field required for browsers and screen readers. The server is still the real check. */
  required?: boolean;
  /** Prefix for the hint and error ids (defaults to `name`), for two forms on one page. */
  idBase?: string;
};

/**
 * Check 32 P10: the <label> holds only the label text and points at the control by id; the hint
 * and the error sit beside it and are the control's description (aria-describedby). Wrapping all
 * three in the label made the box's name "What's the business called? (required) What's the
 * business called?" after a failed save, with the error read again as the description.
 */
const fieldId = (p: Pick<Common, "name" | "idBase">) => `${p.idBase ?? p.name}-field`;

function Label(p: Pick<Common, "name" | "label" | "idBase">) {
  return (
    <label htmlFor={fieldId(p)} className="font-semibold">
      {p.label}
    </label>
  );
}

const describedBy = (p: Pick<Common, "name" | "hint" | "error" | "idBase">) =>
  [
    p.hint ? `${p.idBase ?? p.name}-hint` : null,
    p.error?.length ? `${p.idBase ?? p.name}-error` : null,
  ]
    .filter(Boolean)
    .join(" ") || undefined;

export function TextField({
  defaultValue,
  value,
  onValueChange,
  type = "text",
  inputMode,
  autoComplete,
  disabled,
  ...p
}: Common & {
  disabled?: boolean;
  defaultValue?: string | number | null;
  /** Controlled use (with `onValueChange`); otherwise `defaultValue`. */
  value?: string;
  onValueChange?: (value: string) => void;
  type?: string;
  inputMode?: "numeric" | "email" | "text" | "tel";
  autoComplete?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", p.className)}>
      <Label {...p} />
      <Hint {...p} />
      <input
        id={fieldId(p)}
        name={p.name}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        required={p.required}
        disabled={disabled}
        {...(value !== undefined
          ? { value, onChange: (e) => onValueChange?.(e.target.value) }
          : { defaultValue: defaultValue ?? "" })}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={describedBy(p)}
        className={cn(control, "min-h-tap")}
      />
      <FieldError {...p} />
    </div>
  );
}

function Hint(p: Pick<Common, "name" | "hint" | "idBase">) {
  return p.hint ? (
    <span id={`${p.idBase ?? p.name}-hint`} className="text-sm text-muted-foreground">
      {p.hint}
    </span>
  ) : null;
}

export function TextArea({
  defaultValue,
  rows = 3,
  ...p
}: Common & { defaultValue?: string | null; rows?: number }) {
  return (
    <div className={cn("flex flex-col gap-1.5", p.className)}>
      <Label {...p} />
      <Hint {...p} />
      <textarea
        id={fieldId(p)}
        name={p.name}
        rows={rows}
        required={p.required}
        defaultValue={defaultValue ?? ""}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={describedBy(p)}
        className={control}
      />
      <FieldError {...p} />
    </div>
  );
}

export function SelectField({
  options,
  defaultValue,
  ...p
}: Common & {
  options: readonly { value: string; label: string }[];
  defaultValue?: string | null;
  /** Check 38 P2: an optional select's empty choice ("Not set"), which the owner can pick. */
  emptyLabel?: string;
}) {
  // Check 30 P3: a stored value this code's list doesn't have (newer code put it in the shared
  // database) is shown as its own selected option, so saving the form keeps it. Without it the
  // browser would pick the first option and save that instead.
  const unknown =
    typeof defaultValue === "string" &&
    defaultValue !== "" &&
    !options.some((o) => o.value === defaultValue);
  return (
    <div className={cn("flex flex-col gap-1.5", p.className)}>
      <Label {...p} />
      <Hint {...p} />
      <select
        id={fieldId(p)}
        name={p.name}
        required={p.required}
        defaultValue={defaultValue ?? ""}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={describedBy(p)}
        className={cn(control, "min-h-tap")}
      >
        <option value="" disabled={!p.emptyLabel}>
          {p.emptyLabel ?? "Choose one"}
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
        {unknown ? <option value={defaultValue ?? ""}>Current: {defaultValue}</option> : null}
      </select>
      <FieldError {...p} />
    </div>
  );
}

function FieldError({ name, error, idBase }: Pick<Common, "name" | "error" | "idBase">) {
  if (!error?.length) return null;
  return (
    <span id={`${idBase ?? name}-error`} className="font-semibold">
      {error[0]}
    </span>
  );
}
