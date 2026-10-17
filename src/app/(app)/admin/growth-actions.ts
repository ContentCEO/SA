"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { growthServicesFrom } from "@/config/growth";
import { tradeEnum } from "@/db/schema";
import {
  adminToday,
  checkInMonthOk,
  isGrowthMove,
  isGrowthTimeZone,
  parseCheckIn,
  parseUpdate,
  startDateOk,
} from "@/server/growth-client-rules";
import {
  changeGrowth,
  inviteToGrowth,
  moveGrowthClient,
  notifyGrowthUpdate,
  postGrowthUpdate,
  removeGrowthRequest,
  saveGrowthMonth,
  sendGrowthInviteEmail,
  startGrowth,
} from "@/server/growth-clients";
import { requireAdmin } from "@/server/session";

/**
 * Squared Away Growth, Davi's side (2026-10-16): every action re-checks requireAdmin() first
 * (anyone else gets the admin page's 404), validates on the server whatever the form sent, and
 * answers with a fixed code. `growth_*` notices show on /admin/growth, `wl_*` in /admin's
 * waitlist section.
 */

const id = z.string().uuid();

/** Services and a start date, as every Growth form sends them; null when either is unusable. */
function servicesAndStart(formData: FormData) {
  const services = growthServicesFrom(formData.getAll("services"));
  const startedOn = formData.get("startedOn");
  if (services.length === 0 || !startDateOk(startedOn, adminToday(new Date()))) return null;
  return { services, startedOn };
}

/** The client's time zone (their dashboard's months); only the listed US zones. */
function timeZoneOf(formData: FormData): string | null {
  const tz = formData.get("timeZone");
  return isGrowthTimeZone(tz) ? tz : null;
}

/** "Start Growth for this account": an existing account, picked the way /admin lists them. */
export async function startGrowthAction(formData: FormData) {
  await requireAdmin();
  const workspaceId = id.safeParse(formData.get("workspaceId"));
  const picked = servicesAndStart(formData);
  const timeZone = timeZoneOf(formData);
  if (!workspaceId.success || !picked || !timeZone) redirect("/admin/growth?error=growth_input");
  const r = await startGrowth({ workspaceId: workspaceId.data, ...picked, timeZone });
  if (r === "already") redirect("/admin/growth?error=growth_already");
  if (r === "not_found") redirect("/admin/growth?error=growth_not_found");
  redirect(`/admin/growth?done=growth_${r}`);
}

/** Change a client's services, start date or time zone. */
export async function changeGrowthAction(formData: FormData) {
  await requireAdmin();
  const clientId = id.safeParse(formData.get("clientId"));
  const picked = servicesAndStart(formData);
  const timeZone = timeZoneOf(formData);
  if (!clientId.success || !picked || !timeZone) redirect("/admin/growth?error=growth_input");
  if (!(await changeGrowth({ clientId: clientId.data, ...picked, timeZone })))
    redirect("/admin/growth?error=growth_not_found");
  redirect("/admin/growth?done=growth_changed");
}

/** Pause, resume or end (each behind its own confirmation on the page). */
export async function moveGrowthAction(formData: FormData) {
  await requireAdmin();
  const clientId = id.safeParse(formData.get("clientId"));
  const move = formData.get("move");
  if (!clientId.success || !isGrowthMove(move)) redirect("/admin/growth?error=growth_input");
  const r = await moveGrowthClient(clientId.data, move);
  if (r === "not_found") redirect("/admin/growth?error=growth_not_found");
  if (r === "not_allowed") redirect("/admin/growth?error=growth_status");
  redirect(`/admin/growth?done=growth_${move}`);
}

/** "Post an update": saved, then emailed to the client once (title and a link only). */
export async function postGrowthUpdateAction(formData: FormData) {
  await requireAdmin();
  const clientId = id.safeParse(formData.get("clientId"));
  const update = parseUpdate(formData.get("title"), formData.get("body"));
  if (!clientId.success || !update.ok) redirect("/admin/growth?error=growth_update_input");
  const posted = await postGrowthUpdate(clientId.data, update);
  if (posted.status === "ended") redirect("/admin/growth?error=growth_ended");
  if (posted.status !== "posted") redirect("/admin/growth?error=growth_not_found");
  const mail = await notifyGrowthUpdate(posted.updateId);
  redirect(
    `/admin/growth?done=${
      mail === "sent" || mail === "already_sent"
        ? "growth_posted_emailed"
        : mail === "not_configured"
          ? "growth_posted_no_email"
          : "growth_posted_unsent"
    }`,
  );
}

/** "Email it to them" on an update whose email didn't go out. Never sends one twice. */
export async function emailGrowthUpdateAction(formData: FormData) {
  await requireAdmin();
  const updateId = id.safeParse(formData.get("updateId"));
  if (!updateId.success) redirect("/admin/growth?error=growth_input");
  const mail = await notifyGrowthUpdate(updateId.data);
  if (mail === "not_configured") redirect("/admin/growth?error=growth_email_off");
  if (mail === "failed") redirect("/admin/growth?error=growth_email_failed");
  redirect(
    `/admin/growth?done=${mail === "skipped" ? "growth_already_emailed" : "growth_emailed"}`,
  );
}

/** "Monthly numbers": one month's check-in, saved (or removed when every box is empty). */
export async function saveGrowthMonthAction(formData: FormData) {
  await requireAdmin();
  const clientId = id.safeParse(formData.get("clientId"));
  const month = formData.get("month");
  const parsed = parseCheckIn((f) => formData.get(f));
  if (!clientId.success || !checkInMonthOk(month, adminToday(new Date())) || !parsed.ok)
    redirect("/admin/growth?error=growth_month_input");
  const r = await saveGrowthMonth(clientId.data, month, parsed.numbers, parsed.note);
  if (r === "not_found") redirect("/admin/growth?error=growth_not_found");
  redirect(`/admin/growth?done=growth_month_${r}`);
}

const growthInvite = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  trade: z.enum(tradeEnum.enumValues).nullable(),
});

/**
 * "Invite to Growth" for someone with no account (from the Growth card, or a waitlist card's
 * Growth request). Lets them sign in to their dashboard; starts no app trial.
 */
export async function inviteToGrowthAction(formData: FormData) {
  await requireAdmin();
  const fromWaitlist = formData.get("from") === "waitlist";
  const parsed = growthInvite.safeParse({
    email: formData.get("email"),
    trade: formData.get("trade") || null,
  });
  const picked = servicesAndStart(formData);
  // Answers go back to the section the form was in.
  const where = fromWaitlist ? "wl_growth" : "growth";
  const page = fromWaitlist ? "" : "/growth";
  const anchor = fromWaitlist ? "#waitlist" : "";
  if (!parsed.success || !picked) redirect(`/admin${page}?error=${where}_input${anchor}`);
  const r = await inviteToGrowth({ ...parsed.data, ...picked });
  if (r === "has_account") redirect(`/admin${page}?error=${where}_has_account${anchor}`);
  const mail = r === "invited" ? await sendGrowthInviteEmail(parsed.data.email) : null;
  const code = r === "updated" ? "invite_updated" : mail === "sent" ? "invited_emailed" : "invited";
  redirect(`/admin${page}?done=${where}_${code}${anchor}`);
}

/**
 * "Remove" on a waitlist card's Growth request (Davi, 2026-10-16), after a confirmation: a
 * Growth-only entry is deleted; an app sign-up keeps everything but the Growth block.
 */
export async function removeGrowthRequestAction(formData: FormData) {
  await requireAdmin();
  const email = z.string().trim().toLowerCase().max(254).email().safeParse(formData.get("email"));
  if (!email.success) redirect("/admin?error=wl_growth_no_request#waitlist");
  const r = await removeGrowthRequest(email.data);
  if (r === "deleted") redirect("/admin?done=wl_growth_request_deleted#waitlist");
  if (r === "block_removed") redirect("/admin?done=wl_growth_request_block_removed#waitlist");
  redirect("/admin?error=wl_growth_no_request#waitlist");
}
