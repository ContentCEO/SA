/**
 * Check 15 P6: the owner's sign-off (Your voice) and signature (Your business) are asked for
 * apart, but an owner who typed "Thanks, Mike" in both would get it twice at the end of a
 * reply. Pure: the signature's first line is dropped before the prompt when it is the sign-off.
 * The saved signature is never changed.
 */
const comparable = (s: string) =>
  s
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[.,!;:–—-]+$/u, "");

export function signatureWithoutSignoff(
  signature: string | null | undefined,
  signoff: string | null | undefined,
): string | null {
  if (!signature?.trim()) return null;
  if (!signoff?.trim()) return signature;
  const lines = signature.split("\n");
  const first = lines.findIndex((l) => l.trim());
  if (comparable(lines[first]!) !== comparable(signoff)) return signature;
  const rest = lines
    .slice(first + 1)
    .join("\n")
    .trim();
  return rest || null;
}
