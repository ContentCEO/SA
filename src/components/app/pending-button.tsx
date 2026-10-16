"use client";

import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/** A submit button that says it's working, for actions that take a few seconds. */
export function PendingButton({
  children,
  pending: pendingLabel,
  className,
  variant,
}: {
  children: React.ReactNode;
  pending: string;
  className?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
}) {
  const { pending } = useFormStatus();
  return (
    <Button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={className}
      variant={variant}
    >
      {pending ? pendingLabel : children}
    </Button>
  );
}
