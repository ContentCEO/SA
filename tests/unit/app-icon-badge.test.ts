import { describe, expect, it } from "vitest";
import { GET, generateStaticParams } from "@/app/app-icon/[size]/route";
import { decodePng } from "../support/png";

/* Check 46 P3: the notification badge is the "sa." mark alone, on a transparent background. */
const render = async (size: string) =>
  GET(new Request(`https://sa.example/app-icon/${size}`), {
    params: Promise.resolve({ size }),
  } as Parameters<typeof GET>[1]);

describe("the notification badge icon", () => {
  it("is built once with the others", () => {
    expect(generateStaticParams()).toContainEqual({ size: "badge-96" });
  });

  it("is a 96px PNG: corners fully transparent, at least half of it clear, the mark inside", async () => {
    const res = await render("badge-96");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const { width, height, rgba } = decodePng(Buffer.from(await res.arrayBuffer()));
    expect([width, height]).toEqual([96, 96]);
    const alpha = (x: number, y: number) => rgba[(y * width + x) * 4 + 3]!;
    for (const [x, y] of [
      [0, 0],
      [95, 0],
      [0, 95],
      [95, 95],
    ])
      expect(alpha(x!, y!), `${x},${y}`).toBe(0);
    let clear = 0;
    let inked = 0;
    let outside = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const a = alpha(x, y);
        if (a === 0) clear++;
        else {
          inked++;
          // Android's mask: nothing in the outer 10% on any side.
          if (x < 9.6 || x >= 86.4 || y < 9.6 || y >= 86.4) outside++;
        }
      }
    expect(clear).toBeGreaterThanOrEqual((width * height) / 2);
    expect(inked).toBeGreaterThan(0);
    expect(outside).toBe(0);
  });

  it("the full app icon stays the filled square", async () => {
    const { rgba, width, height } = decodePng(
      Buffer.from(await (await render("192")).arrayBuffer()),
    );
    let opaque = 0;
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 255) opaque++;
    expect(opaque / (width * height)).toBeGreaterThan(0.9);
  });
});
