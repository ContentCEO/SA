import { cn } from "@/lib/utils";

type HeadlineProps = {
  /** The light italic serif line, e.g. "your inbox," */
  serif: string;
  /** The heavy sans line. Should end in a period, e.g. "handled." */
  heavy: string;
  as?: "h1" | "h2" | "h3";
  size?: "xl" | "lg" | "md";
  className?: string;
};

const sizes = {
  xl: { serif: "text-5xl", heavy: "text-6xl" },
  lg: { serif: "text-3xl", heavy: "text-4xl" },
  md: { serif: "text-2xl", heavy: "text-3xl" },
} as const;

/** The signature stacked headline used for every major heading. */
export function Headline({ serif, heavy, as: Tag = "h1", size = "lg", className }: HeadlineProps) {
  return (
    <Tag className={cn("flex flex-col", className)}>
      <span className={cn("sa-headline-serif", sizes[size].serif)}>{serif}</span>
      <span className={cn("sa-headline-heavy", sizes[size].heavy)}>{heavy}</span>
    </Tag>
  );
}
