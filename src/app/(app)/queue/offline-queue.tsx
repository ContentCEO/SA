"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  addIntent,
  clearIntents,
  INTENT_MAX_AGE_MS,
  OFFLINE_CACHE,
  readIntents,
  removeIntent,
} from "@/lib/offline-intents";

const WHY: Record<string, string> = {
  changed_since_seen: "it changed since you okayed it",
  changed_in_gmail: "it was changed in Gmail",
  deleted_in_gmail: "it was deleted or sent from Gmail",
  not_found: "it's no longer waiting",
  gaps_unfilled: "it still has gaps to fill in",
  intent_expired: "you okayed it more than 12 hours ago",
  reconnect_needed: "Gmail needs reconnecting",
  blocked: "sending isn't switched on for your account",
};

/**
 * Plan #10, off unless the owner switched it on for this phone. On: keep a
 * copy of the queue for no-signal moments (the service worker fills the
 * cache) and, once back online, post each stored okay. The server treats it
 * as a fresh tap — full gate, and the draft must be exactly what they saw.
 * Off: delete the copy and any stored okays.
 */
export function OfflineQueue({ enabled }: { enabled: boolean }) {
  const [notes, setNotes] = useState<string[]>([]);
  const router = useRouter();

  useEffect(() => {
    if (!("caches" in window)) return;
    if (!enabled) {
      caches.delete(OFFLINE_CACHE).catch(() => {});
      clearIntents();
      return;
    }
    caches.open(OFFLINE_CACHE).catch(() => {});

    let running = false;
    const flush = async () => {
      if (running || !navigator.onLine) return;
      running = true;
      const out: string[] = [];
      const queued: string[] = [];
      for (const i of readIntents()) {
        removeIntent(i.draftId);
        if (Date.now() - i.at > INTENT_MAX_AGE_MS) {
          out.push(`Your reply to ${i.to} wasn't sent — ${WHY.intent_expired}. Check it again.`);
          continue;
        }
        try {
          const res = await fetch(`/api/drafts/${i.draftId}/send`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ body: i.body, seen: i.seen, okayedAt: i.at }),
          });
          const r = (await res.json().catch(() => ({}))) as { status?: string };
          if (res.status === 202) queued.push(i.draftId);
          else {
            const why = res.status === 403 ? WHY.blocked : WHY[r.status ?? ""];
            out.push(
              `Your reply to ${i.to} wasn't sent — ${why ?? "something changed"}. It's below to check again.`,
            );
          }
        } catch {
          // Signal dropped again: keep it for next time.
          addIntent(i);
        }
      }
      running = false;
      if (queued.length) {
        const qs = new URLSearchParams(queued.map((d) => ["sent", d]));
        router.push(`/queue?${qs}`);
        return;
      }
      if (out.length) setNotes(out);
    };
    flush();
    window.addEventListener("online", flush);
    return () => window.removeEventListener("online", flush);
  }, [enabled, router]);

  if (!notes.length) return null;
  return (
    <div role="status" className="flex flex-col gap-1 rounded-lg border-2 border-charcoal p-3">
      {notes.map((n) => (
        <p key={n} className="font-semibold">
          {n}
        </p>
      ))}
    </div>
  );
}
