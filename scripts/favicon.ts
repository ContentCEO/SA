/**
 * Rebuilds src/app/favicon.ico (16 and 32px) from src/app/icon.svg, so the tab icon, the home
 * screen icon and the share card all draw the same heavy "sa." (Check 7 P3). Run once after
 * icon.svg changes and commit the result:  pnpm exec tsx scripts/favicon.ts
 *
 * sharp comes with Next (its image optimiser), so it's loaded from Next's own install rather
 * than added as a dependency. The .ico holds PNG images, which every current browser reads.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const fromNext = createRequire(require.resolve("next/package.json"));
/** The little of sharp's API this uses (its types aren't reachable from here). */
type Sharp = (
  input: Buffer,
  options: { density: number },
) => {
  resize(w: number, h: number): { png(): { toBuffer(): Promise<Buffer> } };
};
const sharp = fromNext("sharp") as Sharp;

const ROOT = join(__dirname, "..");
const SIZES = [16, 32];

/** An .ico file: a 6-byte header, one 16-byte entry per image, then the PNGs. */
export function ico(images: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + 16 * images.length;
  const entries = images.map(({ size, png }) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0); // width
    e.writeUInt8(size >= 256 ? 0 : size, 1); // height
    e.writeUInt8(0, 2); // no palette
    e.writeUInt8(0, 3); // reserved
    e.writeUInt16LE(1, 4); // colour planes
    e.writeUInt16LE(32, 6); // bits per pixel
    e.writeUInt32LE(png.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += png.length;
    return e;
  });
  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

async function main() {
  const svg = readFileSync(join(ROOT, "src/app/icon.svg"));
  const images = await Promise.all(
    SIZES.map(async (size) => ({
      size,
      png: await sharp(svg, { density: Math.ceil((72 * size) / 64) * 4 })
        .resize(size, size)
        .png()
        .toBuffer(),
    })),
  );
  writeFileSync(join(ROOT, "src/app/favicon.ico"), ico(images));
  console.log(`favicon.ico: ${SIZES.join(" and ")}px`);
}

if (require.main === module) void main();
