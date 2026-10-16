import type { Trade } from "./trades";

/**
 * Kinds of job, per trade (plan #35 monthly summary, plan M8 A11). The model's "what the
 * customer wants" is the customer's own words, so it never leaves the app: code maps it
 * onto one of these fixed labels and only the label is stored on the thread or counted.
 *
 * Matching is by whole words (a trailing "s"/"es" is fine), in list order: the first kind
 * with a matching keyword wins, so the more specific kinds come first. Anything else is
 * OTHER_JOB_KIND. `Record<Trade, …>` makes a new trade without a list a compile error.
 */
export type JobKind = { label: string; keywords: readonly string[] };

export const OTHER_JOB_KIND = "Other jobs";

export const JOB_KINDS: Record<Trade, readonly JobKind[]> = {
  electrical: [
    {
      label: "Panel upgrades",
      keywords: ["panel", "subpanel", "service upgrade", "100 amp", "200 amp", "400 amp", "meter"],
    },
    {
      label: "EV chargers",
      keywords: ["ev charger", "car charger", "charger", "charging station", "tesla", "level 2"],
    },
    { label: "Generators", keywords: ["generator", "transfer switch", "generac", "standby"] },
    { label: "Wiring and rewiring", keywords: ["rewire", "rewiring", "knob and tube", "wiring"] },
    {
      label: "Outlets and circuits",
      keywords: ["outlet", "circuit", "gfci", "afci", "receptacle", "plug", "dedicated line"],
    },
    {
      label: "Lighting",
      keywords: [
        "light",
        "lighting",
        "fixture",
        "recessed",
        "can light",
        "chandelier",
        "ceiling fan",
        "fan",
        "switch",
        "dimmer",
      ],
    },
    {
      label: "Repairs and service calls",
      keywords: [
        "breaker",
        "tripping",
        "flicker",
        "flickering",
        "no power",
        "service call",
        "sparking",
        "repair",
        "troubleshoot",
      ],
    },
  ],
  plumbing: [
    { label: "Water heaters", keywords: ["water heater", "tankless", "hot water"] },
    { label: "Sewer lines", keywords: ["sewer", "septic", "main line", "camera inspection"] },
    {
      label: "Repiping",
      keywords: ["repipe", "repiping", "re pipe", "pex", "galvanized", "copper pipe"],
    },
    { label: "Gas lines", keywords: ["gas line", "gas pipe", "gas leak"] },
    {
      label: "Leaks",
      keywords: ["leak", "leaking", "drip", "dripping", "burst", "burst pipe", "water damage"],
    },
    {
      label: "Drains and clogs",
      keywords: ["drain", "clog", "clogged", "backup", "backed up", "slow drain", "snake"],
    },
    {
      label: "Fixtures",
      keywords: [
        "faucet",
        "toilet",
        "sink",
        "shower",
        "tub",
        "bathtub",
        "disposal",
        "garbage disposal",
        "dishwasher",
        "fixture",
      ],
    },
  ],
  carpentry: [
    { label: "Decks and porches", keywords: ["deck", "decking", "porch", "pergola", "gazebo"] },
    { label: "Fences and gates", keywords: ["fence", "fencing", "gate"] },
    {
      label: "Built-ins and cabinets",
      keywords: [
        "built in",
        "cabinet",
        "shelving",
        "shelf",
        "shelves",
        "bookcase",
        "vanity",
        "pantry",
        "closet",
      ],
    },
    {
      label: "Doors and windows",
      keywords: ["door", "window", "sliding door", "storm door", "entry door"],
    },
    {
      label: "Trim and finish",
      keywords: [
        "trim",
        "molding",
        "moulding",
        "baseboard",
        "crown",
        "casing",
        "wainscoting",
        "finish carpentry",
        "mantel",
      ],
    },
    {
      label: "Framing and additions",
      keywords: ["framing", "frame", "addition", "beam", "load bearing", "joist", "subfloor"],
    },
    { label: "Repairs", keywords: ["repair", "rot", "rotted", "rotten", "fix", "broken"] },
  ],
  hvac: [
    {
      label: "AC and heat pumps",
      keywords: [
        "ac",
        "a/c",
        "air conditioner",
        "air conditioning",
        "central air",
        "heat pump",
        "mini split",
        "ductless",
        "condenser",
      ],
    },
    // Before furnaces: "water heater" is not a furnace (round 2).
    { label: "Water heaters", keywords: ["water heater", "tankless", "hot water"] },
    {
      label: "Furnaces and boilers",
      keywords: ["furnace", "boiler", "space heater", "unit heater", "heating", "radiator"],
    },
    { label: "Ductwork and vents", keywords: ["duct", "ductwork", "vent", "register"] },
    { label: "Thermostats", keywords: ["thermostat", "nest", "ecobee"] },
    {
      label: "Maintenance and tune-ups",
      keywords: ["tune up", "maintenance", "cleaning", "filter", "service plan"],
    },
    {
      label: "Repairs",
      keywords: ["not cooling", "not heating", "no heat", "repair", "broken", "noise"],
    },
  ],
  roofing: [
    // First: "new roof and gutters" is a roof job (round 2). Only roof words here, so
    // "replace the gutters" is still Gutters.
    {
      label: "Roof replacements",
      keywords: [
        "new roof",
        "reroof",
        "re roof",
        "tear off",
        "roof replacement",
        "replace the roof",
        "replace my roof",
        "replace our roof",
        "replace roof",
        "roof replace",
        "full roof",
        "whole roof",
      ],
    },
    { label: "Gutters", keywords: ["gutter", "downspout", "gutter guard"] },
    { label: "Skylights and chimneys", keywords: ["skylight", "chimney", "flashing"] },
    {
      label: "Flat roofs",
      keywords: ["flat roof", "epdm", "tpo", "rubber roof", "membrane"],
    },
    {
      label: "Roof repairs and leaks",
      keywords: ["leak", "leaking", "repair", "shingle", "storm damage", "hail", "patch"],
    },
    { label: "Inspections", keywords: ["inspection", "insurance claim"] },
  ],
  painting: [
    { label: "Cabinet painting", keywords: ["cabinet"] },
    // Not "stain": a water stain on the ceiling is an interior job (round 2).
    { label: "Decks and fences", keywords: ["deck", "fence", "deck stain", "fence stain"] },
    { label: "Commercial painting", keywords: ["commercial", "office", "store", "warehouse"] },
    {
      label: "Exterior painting",
      keywords: ["exterior", "outside", "siding", "house painting", "shutter"],
    },
    {
      label: "Interior painting",
      keywords: [
        "interior",
        "inside",
        "room",
        "bedroom",
        "living room",
        "ceiling",
        "wall",
        "kitchen",
        "bathroom",
        "hallway",
      ],
    },
    {
      label: "Drywall and repairs",
      keywords: ["drywall", "plaster", "wallpaper", "popcorn", "texture", "patch"],
    },
  ],
  landscaping: [
    { label: "Irrigation", keywords: ["irrigation", "sprinkler", "drip line"] },
    {
      label: "Patios and hardscaping",
      keywords: ["patio", "paver", "retaining wall", "walkway", "stone", "fire pit", "hardscape"],
    },
    {
      label: "Tree work",
      keywords: ["tree", "stump", "prune", "pruning", "branch", "limb"],
    },
    {
      label: "Lawn care",
      keywords: [
        "lawn",
        "mow",
        "mowing",
        "grass",
        "sod",
        "seed",
        "aeration",
        "fertilizer",
        "fertilizing",
      ],
    },
    {
      label: "Planting and garden beds",
      keywords: ["planting", "plant", "garden", "flower bed", "mulch", "shrub", "bush", "hedge"],
    },
    // Snow apart from leaf cleanups, and "plow" as customers write it (round 2).
    {
      label: "Snow and plowing",
      keywords: [
        "snow",
        "plow",
        "plowing",
        "plowed",
        "snow removal",
        "shoveling",
        "salting",
        "ice",
      ],
    },
    {
      label: "Cleanups",
      keywords: ["cleanup", "clean up", "leaves", "leaf", "fall cleanup", "spring cleanup"],
    },
  ],
  // Round 2 (TW D1): a general remodeler. The room kinds come first; the generic one last.
  remodeling: [
    { label: "Kitchens", keywords: ["kitchen", "cabinets", "countertop", "backsplash"] },
    {
      label: "Bathrooms",
      keywords: ["bathroom", "bath", "shower", "tub", "bathtub", "vanity", "tile"],
    },
    { label: "Basements", keywords: ["basement", "finish the basement", "finished basement"] },
    {
      label: "Additions",
      keywords: ["addition", "sunroom", "dormer", "in law", "adu", "second story", "bump out"],
    },
    { label: "Siding and windows", keywords: ["siding", "window", "exterior door", "entry door"] },
    { label: "Decks and porches", keywords: ["deck", "porch", "mudroom"] },
    {
      label: "Whole-house renovations",
      keywords: ["whole house", "gut", "renovation", "renovate", "remodel", "rehab", "flooring"],
    },
  ],
  other: [
    { label: "Remodels and renovations", keywords: ["remodel", "renovation", "renovate"] },
    { label: "New installs", keywords: ["install", "installation", "installing"] },
    { label: "Repairs", keywords: ["repair", "fix", "broken", "replace"] },
    { label: "Maintenance", keywords: ["maintenance", "service", "tune up", "cleaning"] },
    { label: "Estimates and inspections", keywords: ["estimate", "inspection", "assessment"] },
  ],
};
