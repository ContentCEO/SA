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
};

const describedBy = (p: Pick<Common, "name" | "hint" | "error">) =>
  [p.hint ? `${p.name}-hint` : null, p.error?.length ? `${p.name}-error` : null]
    .filter(Boolean)
    .join(" ") || undefined;

export function TextField({
  defaultValue,
  type = "text",
  inputMode,
  autoComplete,
  ...p
}: Common & {
  defaultValue?: string | number | null;
  type?: string;
  inputMode?: "numeric" | "email" | "text" | "tel";
  autoComplete?: string;
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", p.className)}>
      <span className="font-semibold">{p.label}</span>
      <Hint {...p} />
      <input
        name={p.name}
        type={type}
        inputMode={inputMode}
        autoComplete={autoComplete}
        required={p.required}
        defaultValue={defaultValue ?? ""}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={describedBy(p)}
        className={cn(control, "min-h-tap")}
      />
      <FieldError {...p} />
    </label>
  );
}

function Hint(p: Pick<Common, "name" | "hint">) {
  return p.hint ? (
    <span id={`${p.name}-hint`} className="text-sm text-muted-foreground">
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
    <label className={cn("flex flex-col gap-1.5", p.className)}>
      <span className="font-semibold">{p.label}</span>
      <Hint {...p} />
      <textarea
        name={p.name}
        rows={rows}
        required={p.required}
        defaultValue={defaultValue ?? ""}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={describedBy(p)}
        className={control}
      />
      <FieldError {...p} />
    </label>
  );
}

export function SelectField({
  options,
  defaultValue,
  ...p
}: Common & { options: { value: string; label: string }[]; defaultValue?: string | null }) {
  return (
    <label className={cn("flex flex-col gap-1.5", p.className)}>
      <span className="font-semibold">{p.label}</span>
      <Hint {...p} />
      <select
        name={p.name}
        required={p.required}
        defaultValue={defaultValue ?? ""}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={describedBy(p)}
        className={cn(control, "min-h-tap")}
      >
        <option value="" disabled>
          Choose one
        </option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <FieldError {...p} />
    </label>
  );
}

function FieldError({ name, error }: Pick<Common, "name" | "error">) {
  if (!error?.length) return null;
  return (
    <span id={`${name}-error`} className="font-semibold">
      {error[0]}
    </span>
  );
}
