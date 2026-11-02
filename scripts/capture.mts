/**
 * Captures the README visuals from the running app (server on BASE_URL) and measures grid scrolling.
 *   node --import tsx scripts/capture.mts <frames-dir> <assets-dir>
 * Frames are PNGs; scripts/make-gif.mts assembles them into a GIF in pure JS (no ffmpeg).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium, type Page } from '@playwright/test';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:8093';
const [framesDir, assetsDir] = process.argv.slice(2);
mkdirSync(framesDir, { recursive: true });
mkdirSync(assetsDir, { recursive: true });

async function signUp(page: Page) {
  await page.goto(BASE);
  await page.fill('input[name=name]', 'Aamod');
  await page.fill('input[name=email]', `capture-${Date.now()}@example.com`);
  await page.fill('input[name=password]', 'password123');
  await page.click('button[type=submit]');
  await page.waitForSelector('[data-testid=new-blank]');
}

const browser = await chromium.launch({ channel: process.env.CI ? undefined : 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 760 }, deviceScaleFactor: 1 });
await signUp(page);

// 1. Training GIF: one gradient step per frame so the boundary visibly forms.
await page.click('[data-testid=new-neural-net]');
await page.waitForSelector('[data-testid=iterbar]');
await page.waitForTimeout(1200);
await page.selectOption('[data-testid=speed]', '1');
await page.click('[data-testid=play]');
for (let i = 0; i < 70; i++) {
  await page.screenshot({
    path: `${framesDir}/f${String(i).padStart(3, '0')}.png`,
    clip: { x: 0, y: 0, width: 1440, height: 712 },
  });
  if (i === 30) await page.selectOption('[data-testid=speed]', '10');
  await page.waitForTimeout(120);
}
await page.click('[data-testid=play]');
await page.waitForTimeout(500);
await page.screenshot({
  path: `${assetsDir}/training-final.png`,
  clip: { x: 0, y: 0, width: 1440, height: 712 },
});
const watches = await page.textContent('[data-testid=watches]');

// 2. The Net sheet: forward and backward pass as spilled blocks.
await page.click('[data-testid=tab-Net]');
await page.waitForTimeout(600);
await page.screenshot({ path: `${assetsDir}/net-sheet.png` });

// 3. Transformer with attention heat-maps.
await page.goto(BASE);
await page.click('[data-testid=new-transformer]');
await page.waitForSelector('[data-testid=action-generate]');
await page.waitForTimeout(800);
await page.getByTestId('namebox').fill('B4');
await page.getByTestId('namebox').press('Enter');
await page.keyboard.type('mari');
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
await page.setViewportSize({ width: 1440, height: 900 });
await page.waitForTimeout(400);
await page.screenshot({ path: `${assetsDir}/transformer.png` });

// 4. Scrolling a million computed rows: frame intervals while the grid scrolls continuously.
await page.goto(BASE);
await page.click('[data-testid=new-blank]');
await page.waitForSelector('[data-testid=status]:has-text("live")');
await page.getByTestId('namebox').fill('A1');
await page.getByTestId('namebox').press('Enter');
await page.keyboard.type('=SEQUENCE(1048576)');
await page.keyboard.press('Enter');
await page.getByTestId('namebox').fill('B1');
await page.getByTestId('namebox').press('Enter');
await page.keyboard.type('=A1#*A1#');
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);
// Passed as source text so the TypeScript loader does not inject helpers into browser code.
const perf = (await page.evaluate(`(async () => {
  const el = document.querySelector('[data-testid=grid]');
  const deltas = [];
  let last = performance.now();
  const start = last;
  await new Promise((resolve) => {
    const tick = () => {
      const now = performance.now();
      deltas.push(now - last);
      last = now;
      el.scrollTop += 7919; // ~360 rows per frame, always landing on unseen rows
      if (now - start < 4000) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  deltas.shift();
  deltas.sort((a, b) => a - b);
  const pct = (p) => deltas[Math.floor((deltas.length - 1) * p)];
  return { frames: deltas.length, p50: pct(0.5), p95: pct(0.95), max: deltas[deltas.length - 1], lastRow: Math.round(el.scrollTop / 22) };
})()`)) as { frames: number; p50: number; p95: number; max: number; lastRow: number };
await page.screenshot({
  path: `${assetsDir}/million-rows.png`,
  clip: { x: 0, y: 0, width: 900, height: 400 },
});
writeFileSync(`${assetsDir}/capture-metrics.json`, JSON.stringify({ watches, scroll: perf }, null, 2));
console.log(JSON.stringify({ watches, scroll: perf }));
await browser.close();
