import { TWEAK_LABELS } from "@/config/tweaks";

export type RecordLog = {
  action: string;
  actor: string;
  detail: Record<string, unknown>;
  at: Date;
};

export type SendRecord = {
  /** "You" or "Autopilot". Never ambiguous. */
  approvedBy: "you" | "autopilot" | "you_in_gmail";
  approvedAt: Date | null;
  device: "phone" | "computer" | null;
  sentAt: Date | null;
  edited: boolean;
  /** Plain names of quick tweaks used, plus "a spoken change" for voice. */
  changes: string[];
  undoWindowSec: number | null;
  /** Autopilot only: the window the owner had to hold it, in minutes. */
  holdWindowMin: number | null;
  undone: number;
  gmailMessageId: string | null;
  draftedAt: Date;
};

/** Pure: the record from the draft row and its log entries (oldest first). */
export function buildSendRecord(
  d: {
    status: string;
    createdAt: Date;
    decidedAt: Date | null;
    sentGmailMessageId: string | null;
  },
  logs: RecordLog[],
  autopilotGraceMin: number,
): SendRecord {
  const sent = logs.findLast((l) => l.action === "reply_sent");
  const fromGmail = logs.findLast((l) => l.action === "reply_sent_from_gmail");
  const approved = logs.findLast((l) => l.action === "send_approved");
  const scheduled = logs.findLast((l) => l.action === "autopilot_scheduled");
  const autopilot = sent?.actor === "squared_away" || sent?.detail.autopilot === true;
  const changes = logs
    .filter((l) => l.action === "draft_revised")
    .map((l) =>
      l.detail.via === "voice"
        ? "a change you said or typed"
        : (TWEAK_LABELS[l.detail.via as keyof typeof TWEAK_LABELS] ?? "a quick change"),
    );
  const device = approved?.detail.device;
  return {
    approvedBy: autopilot ? "autopilot" : !sent && fromGmail ? "you_in_gmail" : "you",
    approvedAt: autopilot ? (scheduled?.at ?? null) : (approved?.at ?? sent?.at ?? null),
    device: device === "phone" || device === "computer" ? device : null,
    sentAt: sent?.at ?? fromGmail?.at ?? d.decidedAt,
    edited: d.status === "edited_and_sent",
    changes,
    undoWindowSec:
      typeof sent?.detail.undoWindowSec === "number" ? sent.detail.undoWindowSec : null,
    holdWindowMin: autopilot ? autopilotGraceMin : null,
    undone: logs.filter((l) => l.action === "send_undone").length,
    gmailMessageId:
      d.sentGmailMessageId ??
      (typeof sent?.detail.gmailMessageId === "string" ? sent.detail.gmailMessageId : null),
    draftedAt: d.createdAt,
  };
}

/**
 * Check 42 P5: the record says only what the app knows. One sign-in per shop, so the app knows
 * which sign-in tapped, never which person; a Gmail send could be anyone with that Gmail.
 */
export function whoOkayedLine(approvedBy: SendRecord["approvedBy"], signedInAs: string | null) {
  if (approvedBy === "autopilot") return "Autopilot — you switched it on for this kind of email";
  if (approvedBy === "you_in_gmail") return "Sent from Gmail, outside the app";
  return signedInAs ? `Your sign-in (${signedInAs})` : "Your sign-in";
}

export function recordClosingLine(approvedBy: SendRecord["approvedBy"], signedInAs: string | null) {
  if (approvedBy === "you_in_gmail")
    return "This reply was sent from Gmail, outside the app, so the app has no tap to show for it.";
  if (approvedBy === "autopilot")
    return "Autopilot sent this on its own, under the rules you switched on.";
  return `This is the record of the tap made while signed in as ${signedInAs ?? "this account"}. Anyone who uses this sign-in can okay replies.`;
}
