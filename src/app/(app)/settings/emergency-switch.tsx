import { AutoSaveForm } from "@/components/forms/auto-save-form";
import { Button } from "@/components/ui/button";
import { EMERGENCY_ALERTS } from "@/server/emergency-alert-rules";
import { saveEmergencyAlertsAction } from "./emergency-actions";

/**
 * Replies package (B5 part 2): the owner's "Emergencies, even at night" switch. On by default
 * (Davi, 2026-10-16). It saves itself once the page's script runs; without it, the button does.
 */
export function EmergencySwitch({
  enabled,
  from,
}: {
  enabled: boolean;
  from: "notifications" | "texts";
}) {
  const id = `emergency-note-${from}`;
  return (
    <AutoSaveForm
      action={saveEmergencyAlertsAction}
      hideButton
      className="flex flex-col gap-2 rounded-xl border-2 border-charcoal p-4"
    >
      <input type="hidden" name="from" value={from} />
      <label className="flex min-h-tap items-center gap-3">
        <input
          type="checkbox"
          name="enabled"
          defaultChecked={enabled}
          aria-describedby={id}
          className="size-6 shrink-0"
        />
        <span className="font-semibold">Emergencies, even at night</span>
      </label>
      <p id={id} className="text-muted-foreground">
        When an email sounds like an emergency — a leak, no heat, no power, a gas smell — we let you
        know right away, even between 9pm and 7am: &ldquo;An emergency email just came in.&rdquo;
        Never a name or what they wrote. Once per conversation, at most {EMERGENCY_ALERTS.nightCap}{" "}
        a night and {EMERGENCY_ALERTS.dayCap} a day. Texts and phone notifications both follow this
        switch.
      </p>
      <Button type="submit" variant="outline" className="sa-autosave-button w-full">
        Save
      </Button>
    </AutoSaveForm>
  );
}
