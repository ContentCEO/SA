/**
 * Plan #10 (opt-in): okays given with no signal, kept on this phone until it's
 * back online. Each holds the draft id, a fingerprint of the text the owner
 * saw, any gaps they filled, and when they tapped. The server re-checks all of
 * it; this file only remembers. Browser-only.
 */
export type Intent = { draftId: string; seen: string; body?: string; at: number; to: string };

const KEY = "sa-offline-intents";
export const INTENT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const OFFLINE_CACHE = "sa-queue-v1";

const listeners = new Set<() => void>();

function raw(): string {
  try {
    return localStorage.getItem(KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

export function readIntents(): Intent[] {
  try {
    const v = JSON.parse(raw()) as Intent[];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function write(list: Intent[]) {
  try {
    if (list.length) localStorage.setItem(KEY, JSON.stringify(list));
    else localStorage.removeItem(KEY);
  } catch {
    // Storage unavailable (private mode): nothing to keep.
  }
  for (const l of listeners) l();
}

export function addIntent(i: Intent) {
  write([...readIntents().filter((x) => x.draftId !== i.draftId), i]);
}
export function removeIntent(draftId: string) {
  write(readIntents().filter((x) => x.draftId !== draftId));
}
export function clearIntents() {
  write([]);
}

/** For useSyncExternalStore: the stored string is a stable snapshot. */
export function subscribeIntents(fn: () => void) {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => e.key === KEY && fn();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}
export const intentsSnapshot = raw;
export const intentsServerSnapshot = () => "[]";

export async function sha256Hex(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
