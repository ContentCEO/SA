import { z } from "zod";

/**
 * Check 30 P3: readers and forms keep values they don't recognize. Previews and production share
 * one database, so a new list value (a trade, a state, a style) can be stored by newer code while
 * older code is live. A form renders such a value as "Current: …" (SelectField) and posts it
 * back unchanged; this lets that exact stored value through validation. Any other value the list
 * doesn't know is still refused with the field's own message.
 *
 * The output type is the field's own: at runtime it can also be the stored value, which the
 * database already holds (for a Postgres enum, the enum has it), so writing it back is safe.
 */
export function orStored<S extends z.ZodType>(schema: S, stored: string | null | undefined): S {
  if (typeof stored !== "string" || stored === "" || schema.safeParse(stored).success) {
    return schema;
  }
  return z.union([z.literal(stored), schema]) as unknown as S;
}

/**
 * The stored values this code doesn't know, from a list it would otherwise rewrite (extra
 * trades): kept as they are, since the form had no box to untick them.
 */
export function unknownStored<T extends string>(
  stored: readonly string[] | null | undefined,
  known: readonly T[],
): string[] {
  return (stored ?? []).filter((v) => !(known as readonly string[]).includes(v));
}
