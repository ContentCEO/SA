/**
 * Check 7 P10: the brand's colors as hex, for the places that can't read CSS variables (emails,
 * the share card, the app icons, the manifest, the browser's theme color). The same values
 * live as `--sa-k-*` in src/styles/theme.css; tests/unit/brand-colors.test.ts keeps the two
 * equal and refuses any other hex color in src. public/offline.html and src/app/icon.svg can't
 * import, so they are the only other copies.
 */
export const BRAND = {
  charcoal: "#1b1b1b",
  offwhite: "#efeeea",
  paper: "#f7f6f3",
  stone: "#d9d7d0",
  ash: "#9a9994",
  slate: "#5e5d59",
  graphite: "#262625",
} as const;

export type BrandColor = keyof typeof BRAND;
