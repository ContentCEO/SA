/**
 * Check 8 P1 / Check 9 P4: what someone typed survives a failed save, a lost signal or a reload
 * — in this tab only (sessionStorage), never localStorage and never sent anywhere. Each copy
 * carries a fingerprint of what the screen was showing when it was typed (the draft's stored
 * text, the saved profile): once that changes (the save went through, or the draft changed),
 * the copy is stale and is dropped instead of restored.
 */
type Kept = { f: string; v: string };

const PREFIX = "sa-kept:";

export function readKept(key: string, fingerprint: string): string | null {
  try {
    const raw = window.sessionStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const kept = JSON.parse(raw) as Kept;
    if (kept?.f !== fingerprint || typeof kept.v !== "string") {
      window.sessionStorage.removeItem(PREFIX + key);
      return null;
    }
    return kept.v;
  } catch {
    return null;
  }
}

export function writeKept(key: string, fingerprint: string, value: string): void {
  try {
    window.sessionStorage.setItem(PREFIX + key, JSON.stringify({ f: fingerprint, v: value }));
  } catch {
    // Private mode or storage full: nothing kept, nothing breaks.
  }
}

export function clearKept(key: string): void {
  try {
    window.sessionStorage.removeItem(PREFIX + key);
  } catch {
    // As above.
  }
}

/** A short, stable fingerprint of any text (not for security: only to notice a change). */
export function fingerprintOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${text.length}:${(h >>> 0).toString(36)}`;
}
