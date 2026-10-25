import "server-only";
import type { MailboxReader, MailboxWriter } from "../connector";
import { createGraphCaller, type GraphOptions } from "./http";
import { createOutlookReader } from "./reader";
import { createPushSubscriptions, type PushSubscriptions } from "./subscriptions";
import { createOutlookWriter } from "./writer";

export type OutlookClient = MailboxReader &
  MailboxWriter & { pushSubscriptions: PushSubscriptions };

/**
 * Plan #49: one Outlook mailbox's client (read + write), built only by `mailboxClientFor`
 * (src/mailbox/clients.ts). Push is not Gmail's `watch` here: Graph change subscriptions live in
 * ./subscriptions.ts, renewed by the daily watch job.
 */
export function createOutlookClient(opts: GraphOptions & { now?: () => Date }): OutlookClient {
  const graph = createGraphCaller(opts);
  const reader = createOutlookReader(graph, { now: opts.now });
  return {
    ...reader,
    ...createOutlookWriter(graph, reader.folderIds),
    pushSubscriptions: createPushSubscriptions(graph),
    async watch() {
      throw new Error("Outlook push uses Graph subscriptions, not watch.");
    },
  };
}
