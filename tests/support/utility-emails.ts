/** Check 37 P3: invented utility emails (the review's four). */
export const UTILITY_EMAILS = {
  status: {
    fromName: "Eversource Work Requests",
    fromAddress: "no-reply@eversource.com",
    subject: "Work request WR-5518311 status",
    body: "The status of work request WR-5518311 (88 Brook Rd) has changed to: Pending Municipal Inspection Release",
  },
  outage: {
    fromName: "National Grid",
    fromAddress: "outage-notices@nationalgrid.com",
    subject: "Planned power outage",
    body: "Power will be turned off at 31 Elm St on Tuesday 10/21 from 9:00 AM to 1:00 PM so service work requested by your electrician can be completed.",
  },
  planner: {
    fromName: "Dana Planner",
    fromAddress: "dana.planner@eversource.com",
    subject: "Cut and reconnect 14 Cedar Ln",
    body: "Your cut and reconnect for 14 Cedar Ln is scheduled for Wednesday 10/22, 8:00 AM. The wiring inspector's release must be on file by Monday noon or the appointment will be cancelled. Reply to confirm.",
  },
  fake: {
    fromName: "Eversource Billing",
    fromAddress: "billing@eversource-payments.com",
    subject: "FINAL NOTICE",
    body: "FINAL NOTICE: power disconnect in 2 hours for non-payment. Avoid disconnection by sending $480 now. Payment through Zelle to the number below.",
  },
};
