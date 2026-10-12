/**
 * Business hours for "a lead is waiting" (plan #34). One default for everyone, in the
 * owner's own time zone. The free-text hours in the business profile are for drafting
 * only and are never parsed. Change here, not in the rules.
 */
export type BusinessHours = {
  /** ISO weekdays: 1 = Monday … 7 = Sunday. */
  days: readonly number[];
  /** Local hour the day starts (inclusive). */
  startHour: number;
  /** Local hour the day ends (exclusive; may be 24 for midnight). */
  endHour: number;
};

/** Monday to Saturday, 7am to 6pm. */
export const BUSINESS_HOURS: BusinessHours = {
  days: [1, 2, 3, 4, 5, 6],
  startHour: 7,
  endHour: 18,
};

/** A quote request unanswered for this many business hours is "at risk". */
export const LEAD_AT_RISK_HOURS = 4;

/**
 * Calendar hours after which an unanswered request is no longer "at risk" but just quiet
 * (the quote tracker shows it). Stops a flood of alerts from the 30-day backfill.
 */
export const LEAD_AT_RISK_MAX_AGE_HOURS = 72;

/** At most this many "a lead is waiting" pushes per owner per local day. */
export const LEAD_AT_RISK_PUSHES_PER_DAY = 3;
