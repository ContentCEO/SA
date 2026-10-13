import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

/**
 * The share card for links to the site: the "your inbox, handled." headline in
 * the brand — Instrument Serif italic over Inter Tight 900, off-white on
 * charcoal. Built once at deploy time.
 */
export const alt = "Squared Away — your inbox, handled.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpengraphImage() {
  const dir = path.join(process.cwd(), "src/app/_og");
  const [serif, heavy] = await Promise.all([
    readFile(path.join(dir, "InstrumentSerif-Italic.ttf")),
    readFile(path.join(dir, "InterTight-Black.ttf")),
  ]);
  return new ImageResponse(
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: "#1B1B1B",
        color: "#EFEEEA",
        padding: "72px 80px",
      }}
    >
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
        <span style={{ fontFamily: "Instrument Serif", fontStyle: "italic", fontSize: 40 }}>
          squared
        </span>
        <span
          style={{ fontFamily: "Inter Tight", fontWeight: 900, fontSize: 48, letterSpacing: -2 }}
        >
          away.
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", lineHeight: 1 }}>
        <span style={{ fontFamily: "Instrument Serif", fontStyle: "italic", fontSize: 120 }}>
          your inbox,
        </span>
        <span
          style={{
            fontFamily: "Inter Tight",
            fontWeight: 900,
            fontSize: 168,
            letterSpacing: -6,
            wordSpacing: "0.14em",
          }}
        >
          handled.
        </span>
      </div>
      <span style={{ fontFamily: "Inter Tight", fontWeight: 900, fontSize: 30, color: "#9A9994" }}>
        Built for carpenters and the trades they work with. Nothing goes out without your okay.
      </span>
    </div>,
    {
      ...size,
      fonts: [
        { name: "Instrument Serif", data: serif, style: "italic", weight: 400 },
        { name: "Inter Tight", data: heavy, style: "normal", weight: 900 },
      ],
    },
  );
}
