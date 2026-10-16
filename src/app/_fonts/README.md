Fonts for every page, self-hosted with `next/font/local` (`src/app/layout.tsx`) so a build never
downloads anything. Since 2026-10-15; before that Next's Google font loader fetched them at build
time, and CI builds failed whenever Google Fonts was unreachable.

- `InterTight-latin.woff2`: Inter Tight, variable (weight axis 100–900), latin subset.
- `InstrumentSerif-Italic-latin.woff2`: Instrument Serif Italic 400, latin subset.

Both are the exact latin files Google Fonts served to Next's loader (CSS2 API, Inter Tight v9,
Instrument Serif v5), byte for byte the same as the files earlier builds put in
`/_next/static/media`. Characters outside the latin subset (ł, ő, ệ, Greek, Cyrillic) now use
the fallback font; earlier builds also carried Google's other subsets, loaded on demand.

Both families are under the SIL Open Font License 1.1, with no Reserved Font Name:
`InterTight-OFL.txt` and `InstrumentSerif-OFL.txt` (from google/fonts, `ofl/intertight` and
`ofl/instrumentserif`).

To refresh them: request the CSS2 URL Next built (`family=Inter+Tight:wght@400;600;900` and
`family=Instrument+Serif:ital,wght@1,400`, `display=swap`) with a modern Chrome User-Agent, take
the `/* latin */` block's `src` URL and keep the `unicode-range` in `layout.tsx` in step with it.
`_fonts` is a private folder, not a route. `tests/unit/fonts.test.ts` checks the files and that
nothing imports the Google loader again.
