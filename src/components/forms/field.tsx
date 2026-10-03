import { cn } from "@/lib/utils";

const control =
  "w-full rounded-lg border border-input bg-paper px-3 py-2.5 text-base text-foreground placeholder:text-slate focus-visible:outline-2 focus-visible:outline-ring aria-invalid:border-charcoal aria-invalid:border-2";

type Common = { name: string; label: string; hint?: string; error?: string[]; className?: string };

export function TextField({
  defaultValue,
  type = "text",
  inputMode,
  ...p
}: Common & {
  defaultValue?: string | number | null;
  type?: string;
  inputMode?: "numeric" | "email" | "text";
}) {
  return (
    <label className={cn("flex flex-col gap-1.5", p.className)}>
      <span className="font-semibold">{p.label}</span>
      {p.hint ? <span className="text-sm text-muted-foreground">{p.hint}</span> : null}
      <input
        name={p.name}
        type={type}
        inputMode={inputMode}
        defaultValue={defaultValue ?? ""}
        aria-invalid={p.error ? true : undefined}
        className={cn(control, "min-h-tap")}
      />
      <FieldError error={p.error} />
    </label>
  );
}

export function TextArea({
  defaultValue,
  rows = 3,
  ...p
}: Common & { defaultValue?: string | null; rows?: number }) {
  return (
    <label className={cn("flex flex-col gap-1.5", p.className)}>
      <span className="font-semibold">{p.label}</span>
      {p.hint ? <span className="text-sm text-muted-foreground">{p.hint}</span> : null}
      <textarea
        name={p.name}
        rows={rows}
        defaultValue={defaultValue ?? ""}
        aria-invalid={p.error ? true : undefined}
        className={control}
      />
      <FieldError error={p.error} />
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
      {p.hint ? <span className="text-sm text-muted-foreground">{p.hint}</span> : null}
      <select
        name={p.name}
        defaultValue={defaultValue ?? ""}
        aria-invalid={p.error ? true : undefined}
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
      <FieldError error={p.error} />
    </label>
  );
}

function FieldError({ error }: { error?: string[] }) {
  if (!error?.length) return null;
  return <span className="font-semibold">{error[0]}</span>;
}
