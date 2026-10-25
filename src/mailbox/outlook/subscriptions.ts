import "server-only";
import type { GraphCaller } from "./http";

/**
 * Plan #49: Microsoft Graph change notifications for one mailbox (push). Outlook message
 * subscriptions last at most 10,080 minutes (learn.microsoft.com/graph/api/resources/
 * subscription) and must be renewed before then; we ask for 10,000 and the daily job renews
 * anything with under two days left. A notification only says "something changed": the route
 * enqueues a sync and handles no content.
 */
export const MAX_SUBSCRIPTION_MINUTES = 10_080;
export const SUBSCRIPTION_MINUTES = 10_000;

export type PushSubscriptions = {
  create(opts: {
    notificationUrl: string;
    clientState: string;
    expiresAt: Date;
  }): Promise<{ id: string; expiresAt: Date }>;
  /** null when Graph no longer has it (expired or removed): make a new one. */
  renew(id: string, expiresAt: Date): Promise<{ id: string; expiresAt: Date } | null>;
  /** Must not throw if it's already gone. */
  remove(id: string): Promise<void>;
};

type Sub = { id: string; expirationDateTime: string };

export function createPushSubscriptions(graph: GraphCaller): PushSubscriptions {
  const path = (id: string) => `/subscriptions/${encodeURIComponent(id)}`;
  return {
    async create({ notificationUrl, clientState, expiresAt }) {
      const r = await graph.call<Sub>("/subscriptions", {
        method: "POST",
        json: {
          // New, changed (moved) and deleted mail anywhere in the mailbox: each only wakes a
          // sync, which reads what changed through delta.
          changeType: "created,updated,deleted",
          notificationUrl,
          resource: "me/messages",
          expirationDateTime: expiresAt.toISOString(),
          clientState,
        },
      });
      if (!r?.id) throw new Error("Graph subscription create failed.");
      return { id: r.id, expiresAt: new Date(r.expirationDateTime) };
    },
    async renew(id, expiresAt) {
      const r = await graph.call<Sub>(path(id), {
        method: "PATCH",
        json: { expirationDateTime: expiresAt.toISOString() },
      });
      return r?.id ? { id: r.id, expiresAt: new Date(r.expirationDateTime) } : null;
    },
    async remove(id) {
      await graph.call(path(id), { method: "DELETE" });
    },
  };
}
