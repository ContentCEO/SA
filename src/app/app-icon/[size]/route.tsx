import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

/**
 * Home-screen icons for the installable app, drawn from the brand (charcoal
 * square, off-white "sa."). Placeholder until Davi's icon pack lands in
 * public/brand/ — then point the manifest at those files instead.
 *
 * `maskable-512` keeps the mark inside the safe zone so Android can crop it
 * into a circle or squircle without clipping.
 *
 * Check 7 P3: drawn in Inter Tight Black (the share card's file, src/app/_og), the same heavy
 * "sa." as the site, the tab icon (icon.svg, outlined) and the favicon. Without a font passed,
 * the renderer used its own regular-weight face and fontWeight 900 did nothing.
 */
const SIZES: Record<string, { px: number; maskable: boolean }> = {
  "192": { px: 192, maskable: false },
  "512": { px: 512, maskable: false },
  "maskable-512": { px: 512, maskable: true },
  "apple-180": { px: 180, maskable: true },
};

export function generateStaticParams() {
  return Object.keys(SIZES).map((size) => ({ size }));
}

export async function GET(_req: Request, ctx: RouteContext<"/app-icon/[size]">) {
  const { size } = await ctx.params;
  const spec = SIZES[size];
  if (!spec) return new Response("Not found", { status: 404 });
  const { px, maskable } = spec;
  const font = Math.round(px * (maskable ? 0.36 : 0.46));
  const black = await readFile(path.join(process.cwd(), "src/app/_og/InterTight-Black.ttf"));
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#1B1B1B",
        borderRadius: maskable ? 0 : Math.round(px * 0.19),
        color: "#EFEEEA",
        fontFamily: "Inter Tight",
        fontSize: font,
        fontWeight: 900,
        letterSpacing: -font * 0.05,
        paddingBottom: Math.round(px * 0.04),
      }}
    >
      sa.
    </div>,
    {
      width: px,
      height: px,
      fonts: [{ name: "Inter Tight", data: black, weight: 900, style: "normal" }],
    },
  );
}
