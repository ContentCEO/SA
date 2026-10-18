import type { Metadata } from "next";
import { MenuList, type MenuItem } from "@/components/app/menu-list";
import { Notice } from "@/components/app/notice";
import { Headline } from "@/components/brand/headline";
import { devicePrefs } from "@/lib/device-prefs";
import { smsConfigured } from "@/lib/sms";
import { vapidPublicKey } from "@/lib/web-push";
import { isAdminEmail } from "@/server/admin";
import { autopilotState } from "@/server/autopilot";
import { listMailboxes } from "@/server/mailboxes";
import { getBusinessProfile, getVoiceProfile } from "@/server/profile";
import { requireOwner } from "@/server/session";
import { formatUsPhone } from "@/server/sms-alerts";
import { zoneShortName } from "@/server/time-zone-rules";
import { LegacySettingsAnchors } from "./legacy-anchors";
import { LIST_MESSAGES } from "./messages";
import { awayState } from "@/server/away";
import { awayUntilShort } from "@/server/away-rules";
import { listRules } from "@/server/sender-rule-store";

export const metadata: Metadata = { title: "Settings" };

/**
 * Settings as a short list (outside review, I4): each part on its own screen, with a line
 * saying what's set now. Old `/settings#section` links open the screen that holds it.
 */
export default async function SettingsPage(props: PageProps<"/settings">) {
  const { workspace, session } = await requireOwner();
  const admin = isAdminEmail(session?.user?.email);
  const params = await props.searchParams;
  const [mailboxes, profile, voice, autopilot, device, away, senderRules] = await Promise.all([
    listMailboxes(workspace.id),
    getBusinessProfile(workspace.id),
    getVoiceProfile(workspace.id),
    autopilotState(workspace),
    devicePrefs(),
    awayState(workspace.id),
    listRules(workspace.id),
  ]);
  const doneMsg = typeof params.done === "string" ? LIST_MESSAGES.done[params.done] : undefined;
  const errorMsg = typeof params.error === "string" ? LIST_MESSAGES.error[params.error] : undefined;
  const lost = mailboxes.some((m) => m.status === "reconnect_needed" && !m.planPausedAt);
  const pausedOnPlan = mailboxes.filter((m) => m.planPausedAt).length;
  const autopilotOn = autopilot.categories.filter((c) => c.on).length;

  const items: MenuItem[] = [
    {
      href: "/settings/gmail",
      label: "Your Gmail",
      line: lost
        ? "Needs reconnecting"
        : mailboxes.length
          ? `${mailboxes
              .filter((m) => !m.planPausedAt)
              .map((m) => m.email)
              .join(", ")}${pausedOnPlan ? ` · ${pausedOnPlan} paused on your plan` : ""}`
          : "Not connected yet",
      needsYou: lost,
    },
    {
      href: "/settings/business",
      label: "Your business",
      line: profile?.completedAt ? workspace.businessName : "Not filled in yet",
    },
    {
      href: "/settings/writing",
      label: "Your voice",
      line:
        voice?.status === "ready"
          ? voice.source === "edited"
            ? "Learned, with your changes"
            : "Learned from your sent mail"
          : voice?.status === "learning"
            ? "Learning from your sent mail…"
            : "Not learned yet",
    },
    {
      href: "/settings/follow-ups",
      label: "Follow-ups",
      line:
        (profile?.followupsEnabled ?? true)
          ? `On · after ${profile?.followupDays ?? 3} quiet days`
          : "Off",
    },
    {
      href: "/settings/away",
      label: "Away mode",
      line: away.on && away.backOn ? `On until ${awayUntilShort(away.backOn)}` : "Off",
    },
    {
      href: "/settings/sender-rules",
      label: "Sender rules",
      line: senderRules.length
        ? `${senderRules.length} rule${senderRules.length === 1 ? "" : "s"}`
        : "None yet",
    },
    {
      href: "/settings/autopilot",
      label: "Autopilot",
      line: autopilot.lockedReason
        ? "Not available yet"
        : autopilotOn
          ? `On for ${autopilotOn} kind${autopilotOn === 1 ? "" : "s"} of email`
          : "Off",
    },
    {
      href: "/settings/morning-email",
      label: "Morning email",
      line:
        (profile?.digestEnabled ?? true)
          ? `On · ${profile?.digestHour ?? 7}:00 am ${zoneShortName(profile?.timeZone)}`
          : "Off",
    },
  ];
  if (vapidPublicKey()) {
    items.push({
      href: "/settings/notifications",
      label: "Notifications",
      line: "Phone alerts for new quote requests",
    });
  }
  if (smsConfigured()) {
    items.push({
      href: "/settings/texts",
      label: "Text alerts",
      line:
        profile?.alertPhoneVerifiedAt && profile.alertPhone
          ? `${profile.smsAlertsEnabled ? "On" : "Off"} · ${formatUsPhone(profile.alertPhone)}`
          : "Off",
    });
  }
  items.push(
    {
      href: "/settings/phone",
      label: "This phone",
      line: `${device.leftHanded ? "Left hand" : "Right hand"}${
        device.offline ? " · keeps your queue" : ""
      } · get the app`,
    },
    { href: "/billing", label: "Plan & billing", line: "Your plan and payments" },
    { href: "/settings/account", label: "Account", line: "Sign out, or delete your account" },
  );
  if (admin) items.push({ href: "/admin", label: "Admin", line: "Accounts, invites and payments" });

  return (
    <>
      <LegacySettingsAnchors />
      <Headline serif="your shop," heavy="your settings." />
      {doneMsg ? <Notice>{doneMsg}</Notice> : null}
      {errorMsg ? <Notice strong>{errorMsg}</Notice> : null}
      <MenuList label="Settings" items={items} />
    </>
  );
}
