/**
 * Check 44 P4: town and city email domains that aren't .gov or <town>.<state>.us, matched
 * exactly (or as a subdomain). Each one is confirmed on the town's own website staff directory
 * before it goes in — never guessed, and never a broad pattern like "…ma.org", which would match
 * unrelated businesses.
 *
 * Not included, decide later: fire departments, school districts and town light plants (a light
 * plant is the electric company, not the building office).
 */
export const MUNICIPAL_EMAIL_DOMAINS: readonly string[] = [
  // Town of Littleton, MA: staff listed as first-initial-surname@littletonma.org and the building
  // office as buildings@littletonma.org on the town's online staff directory (checked 2026-10-16).
  "littletonma.org",
  // Town of Sherborn, MA: staff listed as first-initial-surname@sherbornma.org on the town's online
  // staff directory (checked 2026-10-16).
  "sherbornma.org",
];
