"use server";

import { redirect } from "next/navigation";
import {
  confirmPhone,
  removeAlertPhone,
  setSmsAlerts,
  SmsError,
  startPhoneVerification,
} from "@/server/sms-alerts";
import { requireOwner } from "@/server/session";

const back = (q: string) => `/settings?${q}#texts`;

async function attempt(fn: () => Promise<unknown>, ok: string) {
  try {
    await fn();
  } catch (err) {
    if (err instanceof SmsError) redirect(back(`error=sms_${err.code}`));
    throw err;
  }
  redirect(back(`done=${ok}`));
}

export async function sendSmsCodeAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const phone = String(formData.get("phone") ?? "");
  await attempt(() => startPhoneVerification(workspace.id, phone), "sms_code");
}

export async function confirmSmsCodeAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const code = String(formData.get("code") ?? "");
  await attempt(() => confirmPhone(workspace.id, code), "sms_on");
}

export async function toggleSmsAlertsAction(formData: FormData) {
  const { workspace } = await requireOwner();
  const enabled = formData.get("enabled") === "on";
  await attempt(() => setSmsAlerts(workspace.id, enabled), enabled ? "sms_on" : "sms_off");
}

export async function removeSmsPhoneAction() {
  const { workspace } = await requireOwner();
  await attempt(() => removeAlertPhone(workspace.id), "sms_removed");
}
