import "server-only";
import {
  HistoryExpiredError,
  InvalidPageTokenError,
  MAIL_LABELS,
  type HistoryPage,
  type LabelChange,
  type MailboxReader,
  type MessageRef,
} from "../connector";
import { GraphRequestError, type GraphCaller } from "./http";
import {
  countGraphAttachments,
  toMailMessage,
  WELL_KNOWN_FOLDERS,
  type FolderIds,
  type GraphAttachment,
  type GraphMessage,
} from "./parse";

/**
 * Plan #49: Outlook's read side over Microsoft Graph.
 *
 * Listing (backfill, re-reads, voice): `receivedDateTime ge <start>` on the inbox, Sent Items or
 * every folder; "everything but the inbox" drops the inbox, Drafts, Deleted Items and Junk in
 * code (Graph can't filter on the folder there). Page tokens are Graph's own `@odata.nextLink`.
 *
 * Incremental sync (`listHistory`): delta queries per folder (inbox, Sent Items, Deleted Items,
 * Junk Email), each filtered to mail received since 30 days before the cursor was made, so every
 * email sync could have stored is tracked. The cursor kept in `mailboxes.history_id` is our own
 * opaque string (`o1.` + base64url JSON of the four delta links); shared code only stores it.
 * One `listHistory` page reads one Graph page from each folder still mid-round; the next page
 * token carries where each folder got to. A delta link Graph no longer accepts (410) =
 * `HistoryExpiredError`, and sync re-reads the gap as for Gmail.
 *
 * Folder moves become the label changes shared code already follows: into the inbox = +INBOX
 * (−TRASH −SPAM), out of it = −INBOX, into Deleted Items = +TRASH, into Junk = +SPAM. Graph has
 * no "deleted for good" signal we can tell apart from a restore, so `deleted` is always empty
 * (a permanently deleted email keeps the TRASH it got when it was moved there).
 */

const LIST_SELECT = "id,conversationId,parentFolderId,isDraft";
const READ_SELECT = [
  "id",
  "conversationId",
  "parentFolderId",
  "isDraft",
  "receivedDateTime",
  "sentDateTime",
  "subject",
  "from",
  "toRecipients",
  "ccRecipients",
  "replyTo",
  "internetMessageId",
  "internetMessageHeaders",
  "bodyPreview",
  "hasAttachments",
].join(",");

/** Folders followed by delta, in the order their changes are applied. */
export const DELTA_FOLDERS = ["inbox", "sentitems", "deleteditems", "junkemail"] as const;
type DeltaFolder = (typeof DELTA_FOLDERS)[number];
type DeltaLinks = Record<DeltaFolder, string>;

const DAY_MS = 86_400_000;
/** How far back a new cursor tracks: the backfill window. */
export const DELTA_TRACK_DAYS = 30;
const DELTA_PAGE_SIZE = 100;

const CURSOR_PREFIX = "o1.";

export function encodeCursor(links: DeltaLinks, done?: DeltaFolder[]): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify({ links, done })).toString("base64url");
}

export function decodeCursor(value: string): { links: DeltaLinks; done: DeltaFolder[] } {
  if (!value.startsWith(CURSOR_PREFIX)) throw new HistoryExpiredError();
  try {
    const parsed = JSON.parse(
      Buffer.from(value.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { links?: Partial<DeltaLinks>; done?: DeltaFolder[] };
    const links = parsed.links ?? {};
    if (!DELTA_FOLDERS.every((f) => typeof links[f] === "string")) throw new Error("bad");
    return {
      links: links as DeltaLinks,
      done: (parsed.done ?? []).filter((f) => DELTA_FOLDERS.includes(f)),
    };
  } catch {
    throw new HistoryExpiredError();
  }
}

/** The first delta request of a round, for each folder (Graph turns it into links). */
export function freshDeltaLinks(now: Date): DeltaLinks {
  const since = new Date(now.getTime() - DELTA_TRACK_DAYS * DAY_MS).toISOString();
  const qs = `$select=${encodeURIComponent("id,conversationId,isDraft")}&$filter=${encodeURIComponent(`receivedDateTime ge ${since}`)}`;
  return Object.fromEntries(
    DELTA_FOLDERS.map((f) => [f, `/me/mailFolders/${f}/messages/delta?${qs}`]),
  ) as DeltaLinks;
}

type DeltaItem = {
  id: string;
  conversationId?: string;
  isDraft?: boolean;
  "@removed"?: { reason?: string };
};

/** What one folder's delta items mean for sync. */
export function deltaChanges(
  folder: DeltaFolder,
  items: DeltaItem[],
): { added: MessageRef[]; labelChanges: LabelChange[] } {
  const added: MessageRef[] = [];
  const labelChanges: LabelChange[] = [];
  for (const it of items) {
    const threadId = it.conversationId ?? "";
    const removed = !!it["@removed"];
    if (folder === "inbox") {
      if (removed) {
        labelChanges.push({ id: it.id, threadId, added: [], removed: [MAIL_LABELS.inbox] });
      } else {
        if (threadId) added.push({ id: it.id, threadId, labelIds: [MAIL_LABELS.inbox] });
        labelChanges.push({
          id: it.id,
          threadId,
          added: [MAIL_LABELS.inbox],
          removed: [MAIL_LABELS.trash, MAIL_LABELS.spam],
        });
      }
    } else if (folder === "sentitems") {
      if (!removed && threadId && !it.isDraft)
        added.push({ id: it.id, threadId, labelIds: [MAIL_LABELS.sent] });
    } else if (!removed) {
      const label = folder === "deleteditems" ? MAIL_LABELS.trash : MAIL_LABELS.spam;
      labelChanges.push({ id: it.id, threadId, added: [label], removed: [MAIL_LABELS.inbox] });
    }
  }
  return { added, labelChanges };
}

export type OutlookReader = Omit<MailboxReader, "watch"> & {
  /** The ids of the well-known folders, read once per client. */
  folderIds(): Promise<FolderIds>;
};

export function createOutlookReader(
  graph: GraphCaller,
  opts: { now?: () => Date } = {},
): OutlookReader {
  const now = opts.now ?? (() => new Date());
  let folders: Promise<FolderIds> | undefined;

  function folderIds(): Promise<FolderIds> {
    folders ??= Promise.all(
      WELL_KNOWN_FOLDERS.map(async (f) => {
        const r = await graph.call<{ id: string }>(`/me/mailFolders/${f}?$select=id`);
        // A folder Graph doesn't know (a mailbox without Junk) just never matches.
        return [f, r?.id ?? `missing:${f}`] as const;
      }),
    ).then((pairs) => Object.fromEntries(pairs) as FolderIds);
    folders.catch(() => {
      folders = undefined;
    });
    return folders;
  }

  return {
    folderIds,

    async getProfile() {
      const me = await graph.call<{ mail?: string | null; userPrincipalName?: string | null }>(
        "/me?$select=mail,userPrincipalName",
      );
      if (!me) throw new Error("Microsoft profile not found.");
      const emailAddress = (me.mail || me.userPrincipalName || "").toLowerCase();
      return { emailAddress, historyId: encodeCursor(freshDeltaLinks(now())) };
    },

    async listMessages(o) {
      const { pageToken, maxResults = 100 } = o;
      const ids = await folderIds();
      const after =
        o.after ??
        (o.newerThanDays !== undefined
          ? new Date(now().getTime() - o.newerThanDays * DAY_MS)
          : undefined);
      const base = o.sentOnly
        ? "/me/mailFolders/sentitems/messages"
        : o.inbox === true
          ? "/me/mailFolders/inbox/messages"
          : "/me/messages";
      const qs = new URLSearchParams({
        $select: LIST_SELECT,
        $top: String(maxResults),
        $orderby: "receivedDateTime desc",
      });
      if (after) qs.set("$filter", `receivedDateTime ge ${after.toISOString()}`);
      let r;
      try {
        r = await graph.call<{ value?: GraphMessage[]; "@odata.nextLink"?: string }>(
          pageToken ?? `${base}?${qs}`,
        );
      } catch (err) {
        if (pageToken && err instanceof GraphRequestError && err.status === 400)
          throw new InvalidPageTokenError();
        throw err;
      }
      // Spam, Trash and unsent drafts are never listed; "not the inbox" drops the inbox too.
      const never = new Set([ids.drafts, ids.deleteditems, ids.junkemail]);
      if (o.inbox === false) never.add(ids.inbox);
      const messages = (r?.value ?? [])
        .filter((m) => !m.isDraft && !(m.parentFolderId && never.has(m.parentFolderId)))
        .filter((m) => !!m.conversationId)
        .map((m) => ({ id: m.id, threadId: m.conversationId! }));
      return { messages, nextPageToken: r?.["@odata.nextLink"] };
    },

    async getMessage(id, { withBody }) {
      const select = withBody ? `${READ_SELECT},body` : READ_SELECT;
      const m = await graph.call<GraphMessage>(
        `/me/messages/${encodeURIComponent(id)}?$select=${encodeURIComponent(select)}`,
        { textBody: withBody },
      );
      if (!m) return null;
      let attachments;
      if (withBody && m.hasAttachments) {
        const a = await graph.call<{ value?: GraphAttachment[] }>(
          `/me/messages/${encodeURIComponent(id)}/attachments?$select=${encodeURIComponent("contentType,size,isInline")}`,
        );
        attachments = countGraphAttachments(a?.value ?? []);
      }
      return toMailMessage(m, await folderIds(), withBody, attachments);
    },

    async listHistory({ startHistoryId, pageToken }): Promise<HistoryPage> {
      const state = decodeCursor(pageToken ?? startHistoryId);
      const links = { ...state.links };
      const done = new Set(state.done);
      const added: MessageRef[] = [];
      const labelChanges: LabelChange[] = [];
      for (const folder of DELTA_FOLDERS) {
        if (done.has(folder)) continue;
        let r;
        try {
          r = await graph.call<{
            value?: DeltaItem[];
            "@odata.nextLink"?: string;
            "@odata.deltaLink"?: string;
          }>(links[folder], { prefer: [`odata.maxpagesize=${DELTA_PAGE_SIZE}`] });
        } catch (err) {
          // 410 Gone: the delta token is too old (or Graph lost the sync state).
          if (err instanceof GraphRequestError && (err.status === 410 || err.status === 400))
            throw new HistoryExpiredError();
          throw err;
        }
        if (!r) throw new HistoryExpiredError();
        const c = deltaChanges(folder, r.value ?? []);
        added.push(...c.added);
        labelChanges.push(...c.labelChanges);
        if (r["@odata.deltaLink"]) {
          links[folder] = r["@odata.deltaLink"];
          done.add(folder);
        } else if (r["@odata.nextLink"]) {
          links[folder] = r["@odata.nextLink"];
        } else {
          throw new HistoryExpiredError();
        }
      }
      const finished = DELTA_FOLDERS.every((f) => done.has(f));
      return {
        added,
        labelChanges,
        deleted: [],
        nextPageToken: finished ? undefined : encodeCursor(links, [...done]),
        // Only the last page's cursor is stored (sync keeps the old one until then).
        historyId: finished ? encodeCursor(links) : startHistoryId,
      };
    },
  };
}
