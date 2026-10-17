/**
 * Pure rules for the stored voice (Check 24 P1, Check 29 P2). "Do we have a voice" is read from
 * the stored fields; "how did the last learn go" from `lastAttempt`. No database here.
 */

export type VoiceAttempt =
  "learning" | "ready" | "not_enough_mail" | "failed" | "capped" | "reconnect_needed";

/** Attempts that ended without a new voice. */
export const UNFINISHED_ATTEMPTS: readonly VoiceAttempt[] = [
  "not_enough_mail",
  "failed",
  "capped",
  "reconnect_needed",
];

/** Times the 15-minute backstop may restart a learn that died at "learning". */
export const MAX_VOICE_RESTARTS = 2;

type StoredVoice = {
  summary: string | null;
  greetingStyle: string | null;
  signoffStyle: string | null;
  examples: string[] | null;
};

type VoiceRow = StoredVoice & {
  status: string;
  lastAttempt: string | null;
  lastAttemptAt: Date | null;
  updatedAt: Date;
};

/** A voice is stored: drafts use it, whatever the last learn said. */
export function hasVoiceContent(v: StoredVoice | null | undefined): boolean {
  if (!v) return false;
  return Boolean(
    v.summary?.trim() ||
    v.greetingStyle?.trim() ||
    v.signoffStyle?.trim() ||
    (v.examples ?? []).length,
  );
}

/** The newest attempt; rows written before Check 24 P1 only have `status`. */
export function voiceAttempt(v: Pick<VoiceRow, "status" | "lastAttempt">): string {
  return v.lastAttempt ?? v.status;
}

export function voiceAttemptAt(v: Pick<VoiceRow, "lastAttemptAt" | "updatedAt">): Date {
  return v.lastAttemptAt ?? v.updatedAt;
}

/** The stored-voice screen's note when the newest learn didn't finish, else null. */
export function lastUpdateNote(v: VoiceRow | null | undefined, timeZone: string): string | null {
  if (!v || !hasVoiceContent(v)) return null;
  const attempt = voiceAttempt(v);
  if (!(UNFINISHED_ATTEMPTS as readonly string[]).includes(attempt)) return null;
  let day: string;
  try {
    day = voiceAttemptAt(v).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone,
    });
  } catch {
    day = voiceAttemptAt(v).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "America/New_York",
    });
  }
  return `The last update didn't finish (${day}). We're still using this voice.`;
}

/** Settings list line for "Your voice", read from what's stored. */
export function voiceListLine(v: (VoiceRow & { source: string }) | null | undefined): string {
  if (v && hasVoiceContent(v))
    return v.source === "edited" ? "Learned, with your changes" : "Learned from your sent mail";
  if (v && voiceAttempt(v) === "learning") return "Learning from your sent mail…";
  return "Not learned yet";
}
