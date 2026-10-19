/**
 * Check 26 P6: the words for a `?done=` / `?error=` code. Only the map's own string entries
 * count: plain indexing would also find what every JS object has built in ("constructor",
 * "__proto__", "toString", "hasOwnProperty"), and rendering one of those breaks the screen.
 */
export function noticeText(map: Record<string, string>, key: unknown): string | undefined {
  if (typeof key !== "string" || !Object.hasOwn(map, key)) return undefined;
  const value = map[key];
  return typeof value === "string" ? value : undefined;
}
