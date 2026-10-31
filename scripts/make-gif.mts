/**
 * Assembles PNG frames into an animated GIF with pure-JS libraries (no ffmpeg needed).
 *   node --import tsx scripts/make-gif.mts <frames-dir> <out.gif> [width] [fps]
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error gifenc ships without type declarations (CommonJS default export)
import gifenc from 'gifenc';
import { PNG } from 'pngjs';

const { GIFEncoder, applyPalette, quantize } = gifenc;

const [dir, out, widthArg = '1100', fpsArg = '7'] = process.argv.slice(2);
const files = readdirSync(dir)
  .filter((f) => f.endsWith('.png'))
  .sort();
const width = Number(widthArg);
const delay = Math.round(1000 / Number(fpsArg));

/** Box-filter downscale of RGBA pixels, which keeps the thin grid lines legible. */
function downscale(png: PNG, w: number): { data: Uint8Array; w: number; h: number } {
  const scale = png.width / w;
  const h = Math.round(png.height / scale);
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * scale);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * scale));
      const y0 = Math.floor(y * scale);
      const y1 = Math.max(y0 + 1, Math.floor((y + 1) * scale));
      const acc = [0, 0, 0];
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * png.width + xx) * 4;
          acc[0] += png.data[i];
          acc[1] += png.data[i + 1];
          acc[2] += png.data[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      data[o] = acc[0] / n;
      data[o + 1] = acc[1] / n;
      data[o + 2] = acc[2] / n;
      data[o + 3] = 255;
    }
  }
  return { data, w, h };
}

const frames = files.map((f) => downscale(PNG.sync.read(readFileSync(join(dir, f))), width));
// One palette from a sample of frames keeps colors stable across the animation.
const sample = new Uint8Array(frames.filter((_, i) => i % 7 === 0).flatMap((f) => [...f.data]));
const palette = quantize(sample, 128);
const gif = GIFEncoder();
frames.forEach((f, i) => {
  const index = applyPalette(f.data, palette);
  gif.writeFrame(index, f.w, f.h, {
    palette: i === 0 ? palette : undefined,
    delay: i === frames.length - 1 ? 2500 : delay,
  });
});
gif.finish();
writeFileSync(out, gif.bytes());
console.log(`${files.length} frames -> ${out} (${(gif.bytes().length / 1e6).toFixed(2)} MB)`);
