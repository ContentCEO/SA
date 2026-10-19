import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { buildShareCardTree } from "@/app/_og/share-card";
import GrowthOpengraphImage from "@/app/growth/opengraph-image";

/** Check 7 P4: the share card's words have real gaps (one span per word, flex gap). */
type El = ReactElement<{ children?: ReactNode; "data-words"?: boolean }>;
function wordRows(node: ReactNode): El[] {
  if (!isValidElement(node)) return [];
  const el = node as El;
  const kids = ([] as ReactNode[]).concat(el.props.children ?? []).flat();
  return [...(el.props["data-words"] ? [el] : []), ...kids.flatMap(wordRows)];
}
const spans = (row: El) => ([] as ReactNode[]).concat(row.props.children ?? []).flat();

describe("share card", () => {
  it("renders the heavy line as one span per word", () => {
    const tree = buildShareCardTree({
      serif: "the marketing side,",
      heavy: "done for you.",
      line: "x",
      heavySize: 136,
    });
    const [serif, heavy] = wordRows(tree);
    expect(spans(heavy!)).toHaveLength(3);
    expect(spans(serif!)).toHaveLength(3);
    const row = heavy!.props as unknown as { style: Record<string, string | number> };
    // About 0.3em at 136px, in pixels (Satori ignores em gaps).
    expect(row.style).toMatchObject({ columnGap: 41, flexWrap: "wrap" });
  });

  it("the homepage's one-word heavy line is still one span", () => {
    const [, heavy] = wordRows(
      buildShareCardTree({ serif: "your inbox,", heavy: "handled.", line: "x" }),
    );
    expect(spans(heavy!)).toHaveLength(1);
  });

  it("/growth/opengraph-image is a 1200x630 PNG", async () => {
    const res = await GrowthOpengraphImage();
    const buf = Buffer.from(await res.arrayBuffer());
    expect(buf.subarray(1, 4).toString()).toBe("PNG");
    expect(buf.readUInt32BE(16)).toBe(1200);
    expect(buf.readUInt32BE(20)).toBe(630);
  }, 60_000);
});
