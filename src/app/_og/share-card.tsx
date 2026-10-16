import { readFile } from "node:fs/promises";
import path from "node:path";
import { ImageResponse } from "next/og";

export const SHARE_SIZE = { width: 1200, height: 630 };

/**
 * A share card in the brand: the wordmark, a serif-over-heavy headline and one line, off-white on
 * charcoal (Instrument Serif italic over Inter Tight 900). Built once at deploy time.
 */
export async function shareCard(o: {
  serif: string;
  heavy: string;
  line: string;
  heavySize?: number;
}) {
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
          {o.serif}
        </span>
        <span
          style={{
            fontFamily: "Inter Tight",
            fontWeight: 900,
            fontSize: o.heavySize ?? 168,
            letterSpacing: -6,
            wordSpacing: "0.14em",
          }}
        >
          {o.heavy}
        </span>
      </div>
      <span style={{ fontFamily: "Inter Tight", fontWeight: 900, fontSize: 30, color: "#9A9994" }}>
        {o.line}
      </span>
    </div>,
    {
      ...SHARE_SIZE,
      fonts: [
        { name: "Instrument Serif", data: serif, style: "italic", weight: 400 },
        { name: "Inter Tight", data: heavy, style: "normal", weight: 900 },
      ],
    },
  );
}
