import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GET } from "@/app/app-icon/[size]/route";

/** Check 7 P3: one heavy "sa." on the home screen, the tab and the favicon. */
describe("app icons", () => {
  it.each(["192", "512", "maskable-512", "apple-180"])("/app-icon/%s is a PNG", async (size) => {
    const res = await GET(new Request(`http://localhost/app-icon/${size}`), {
      params: Promise.resolve({ size }),
    } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    const bytes = Buffer.from(await res.arrayBuffer());
    expect(bytes.subarray(1, 4).toString("latin1")).toBe("PNG");
  });

  it("an unknown size is a 404", async () => {
    const res = await GET(new Request("http://localhost/app-icon/nope"), {
      params: Promise.resolve({ size: "nope" }),
    } as never);
    expect(res.status).toBe(404);
  });

  it("draws in Inter Tight Black, like the share card", () => {
    const route = readFileSync("src/app/app-icon/[size]/route.tsx", "utf8");
    expect(route).toContain("InterTight-Black.ttf");
    expect(route).toContain('fontFamily: "Inter Tight"');
  });

  it("the tab icon is outlined paths, not text in whatever font the computer has", () => {
    const svg = readFileSync("src/app/icon.svg", "utf8");
    expect(svg).not.toMatch(/<text\b/);
    expect(svg).toMatch(/<path\b[^>]*\bd="M/);
    expect(svg).toContain('rx="12"');
    expect(svg).toContain('fill="#1B1B1B"');
    expect(svg).toContain('fill="#EFEEEA"');
  });

  it("favicon.ico holds 16 and 32px images", () => {
    const ico = readFileSync("src/app/favicon.ico");
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect([ico.readUInt8(6), ico.readUInt8(22)]).toEqual([16, 32]);
  });
});
