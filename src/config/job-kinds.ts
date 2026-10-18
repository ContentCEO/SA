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
    // Check 37 P7: first, so "Powerwall with existing solar panels" isn't a panel upgrade.
    {
      label: "Solar and batteries",
      keywords: [
        "solar",
        "solar panel",
        "powerwall",
        "battery backup",
        "home battery",
        "battery storage",
        "interconnection",
      ],
    },
    {
      label: "Panel upgrades",
      keywords: ["panel", "subpanel", "service upgrade", "100 amp", "200 amp", "400 amp", "meter"],
    },
    // Check 37 P7: no bare "charger" (a phone charger outlet) or "tesla" (a Powerwall).
    {
      label: "EV chargers",
      keywords: [
        "ev charger",
        "car charger",
        "charging station",
        "level 2",
        "wall connector",
        "tesla charger",
        "wall charger",
        "ev",
        "electric car",
        "electric vehicle",
        "charging",
      ],
    },
    { label: "Generators", keywords: ["generator", "transfer switch", "generac", "standby"] },
    { label: "Wiring and rewiring", keywords: ["rewire", "rewiring", "knob and tube", "wiring"] },
    {
      label: "Outlets and circuits",
      keywords: ["outlet", "circuit", "gfci", "afci", "receptacle", "plug", "dedicated line"],
    },
    // Check 37 P7: Massachusetts home sales need a 26F smoke and CO certificate.
    {
      label: "Smoke and CO detectors",
      keywords: ["smoke detector", "smoke alarm", "co detector", "carbon monoxide", "26f"],
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
    // Check 36 P9: common Massachusetts work, before Leaks and Fixtures ("frozen pipe, no water
    // at the kitchen sink" isn't a fixture job). "Hot water" stays with Water heaters above.
    { label: "Frozen pipes", keywords: ["frozen", "froze", "freeze", "thaw", "no water"] },
    {
      label: "Sump and ejector pumps",
      keywords: ["sump", "sump pump", "ejector", "sewage pump", "battery backup"],
    },
    { label: "Backflow tests", keywords: ["backflow", "rpz", "cross connection", "double check"] },
    { label: "Boilers and heating", keywords: ["boiler", "indirect", "radiator", "baseboard"] },
    {
      label: "Wells and water treatment",
      keywords: ["well pump", "pressure tank", "softener", "filter", "water treatment"],
    },
    {
      label: "Valves and tanks",
      // "t p" is how "T&P" (the relief valve) reads once normalized.
      keywords: ["shutoff", "shut off", "prv", "pressure reducing", "expansion tank", "t p"],
    },
    {
      label: "Home sale repairs",
      keywords: ["inspection report", "home inspector", "inspector found"],
    },
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
  // Check 39 P7: water heaters first ("heat pump water heater"), then tune-ups (a furnace or
  // AC tune-up is a tune-up), then the equipment, air quality, commercial, and Repairs last.
  hvac: [
    { label: "Water heaters", keywords: ["water heater", "tankless", "hot water"] },
    {
      label: "Maintenance and tune-ups",
      keywords: [
        "tune up",
        "tuneup",
        "maintenance",
        "maintenance plan",
        "service plan",
        "annual service",
        "filter",
      ],
    },
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
    {
      label: "Furnaces and boilers",
      keywords: [
        "furnace",
        "boiler",
        "space heater",
        "unit heater",
        "heating",
        "radiator",
        "heat",
        "heater",
        "oil burner",
        "baseboard",
      ],
    },
    { label: "Ductwork and vents", keywords: ["duct", "ductwork", "vent", "register"] },
    { label: "Thermostats", keywords: ["thermostat", "nest", "ecobee"] },
    {
      label: "Air quality and humidity",
      keywords: [
        "humidifier",
        "dehumidifier",
        "air purifier",
        "air cleaner",
        "uv light",
        "air quality",
        "erv",
        "hrv",
        "ventilation",
      ],
    },
    { label: "Commercial service", keywords: ["rooftop", "rtu", "rooftop unit", "commercial"] },
    {
      label: "Repairs",
      keywords: ["not cooling", "not heating", "no heat", "repair", "broken", "noise"],
    },
  ],
  // Check 40 P5: in this order. Siding before Gutters ("vinyl siding, loose gutter"), and
  // Roof repairs and leaks late, so its "repair" doesn't take siding or chimney jobs.
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
        "roof and gutters",
        "gutters and roof",
      ],
    },
    { label: "Metal roofs", keywords: ["metal roof", "standing seam"] },
    {
      label: "Flat roofs",
      keywords: ["flat roof", "epdm", "tpo", "rubber roof", "membrane"],
    },
    { label: "Ice dams", keywords: ["ice dam", "ice damming", "steam"] },
    { label: "Roof snow removal", keywords: ["snow removal", "roof rake", "shovel the roof"] },
    { label: "Siding", keywords: ["siding", "vinyl siding", "clapboard", "soffit", "fascia"] },
    { label: "Gutters", keywords: ["gutter", "downspout", "gutter guard"] },
    { label: "Skylights and chimneys", keywords: ["skylight", "chimney", "flashing"] },
    { label: "Ventilation", keywords: ["ventilation", "ridge vent", "attic fan"] },
    { label: "Roof certifications", keywords: ["certification", "roof letter"] },
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
    // Check 41 P8: before Exterior painting ("power washing vinyl siding").
    {
      label: "Power washing",
      keywords: [
        "power wash",
        "power washing",
        "pressure wash",
        "pressure washing",
        "house wash",
        "soft wash",
      ],
    },
    {
      label: "Exterior painting",
      keywords: ["exterior", "outside", "siding", "house painting", "shutter"],
    },
    { label: "Floors", keywords: ["epoxy", "garage floor"] },
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
    // Check 41 P8: a kind of its own.
    { label: "Fences", keywords: ["fence", "fencing", "gate"] },
    {
      label: "Tree work",
      keywords: ["tree", "stump", "prune", "pruning", "branch", "limb"],
    },
    // Check 41 P8: Cleanups before Lawn care ("fall cleanup, plus weekly mowing next year").
    {
      label: "Cleanups",
      keywords: [
        "cleanup",
        "clean up",
        "leaves",
        "leaf",
        "fall cleanup",
        "spring cleanup",
        "gutter cleaning",
      ],
    },
    // Check 41 P8: treatments apart from mowing.
    {
      label: "Lawn treatments",
      keywords: [
        "tick",
        "ticks",
        "mosquito",
        "grub",
        "grubs",
        "weed control",
        "crabgrass",
        "fertilize",
        "fertilizing",
        "fertilizer",
        "lime",
        "pest control",
      ],
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
        "overseed",
        "overseeding",
        "dethatch",
        "dethatching",
        "core aeration",
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
  ],
  // Round 2 (TW D1): a general remodeler. The room kinds come first; the generic one last.
  // Check 38 P8: callbacks first (a cracked grout line isn't a new bathroom), then Basements and
  // Additions before the rooms (a basement bath is a basement job; a kitchen addition is an
  // addition).
  remodeling: [
    {
      label: "Callbacks and touch-ups",
      keywords: [
        "callback",
        "warranty",
        "touch up",
        "grout crack",
        "cracking",
        "sticking",
        "nail pop",
        "punch list",
      ],
    },
    { label: "Basements", keywords: ["basement", "finish the basement", "finished basement"] },
    {
      label: "Additions",
      keywords: [
        "addition",
        "sunroom",
        "dormer",
        "in law",
        "adu",
        "second story",
        "bump out",
        "mudroom",
      ],
    },
    { label: "Kitchens", keywords: ["kitchen", "cabinets", "countertop", "backsplash"] },
    {
      label: "Bathrooms",
      keywords: ["bathroom", "bath", "shower", "tub", "bathtub", "vanity", "tile"],
    },
    { label: "Siding and windows", keywords: ["siding", "window", "exterior door", "entry door"] },
    { label: "Decks and porches", keywords: ["deck", "porch"] },
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
