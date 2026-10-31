/**
 * Engine benchmarks. Run with `npm run bench`; prints a JSON report. Each scenario reports the
 * median of several runs where it is cheap enough to repeat.
 */
import { Workbook } from '../src';

function time<T>(fn: () => T): { ms: number; result: T } {
  const t0 = performance.now();
  const result = fn();
  return { ms: performance.now() - t0, result };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function millionCells() {
  const ROWS = 100_000;
  const COLS = 10;
  const wb = new Workbook();
  wb.addSheet('s', 'S');
  const load = time(() => {
    for (let r = 0; r < ROWS; r++) {
      wb.setCell('s', r, 0, r + 1);
      for (let c = 1; c < COLS; c++) {
        // Every formula reads its left neighbour; nine columns of formulas per row.
        wb.setCell('s', r, c, `=${String.fromCharCode(64 + c)}${r + 1}*1.0001+1`);
      }
    }
  });
  const full = time(() => wb.recalc());
  const edits: number[] = [];
  for (let i = 0; i < 9; i++) {
    wb.setCell('s', 500 + i, 0, i);
    edits.push(time(() => wb.recalc()).ms);
  }
  // A column total that depends on all 100k inputs through one range edge.
  wb.setCell('s', 0, 12, `=SUM(A1:A${ROWS})`);
  wb.recalc();
  const rangeEdit: number[] = [];
  for (let i = 0; i < 9; i++) {
    wb.setCell('s', 70_000 + i, 0, i);
    rangeEdit.push(time(() => wb.recalc()).ms);
  }
  return {
    cells: ROWS * COLS,
    formulas: ROWS * (COLS - 1),
    loadMs: load.ms,
    fullRecalcMs: full.ms,
    evaluated: full.result.evaluated,
    singleEditMs: median(edits),
    singleEditWithSumOverColumnMs: median(rangeEdit),
    heapMB: Math.round(process.memoryUsage().heapUsed / 1e6),
  };
}

function longChain() {
  const N = 100_000;
  const wb = new Workbook();
  wb.addSheet('s', 'S');
  wb.setCell('s', 0, 0, 1);
  for (let i = 1; i < N; i++) wb.setCell('s', i, 0, `=A${i}+1`);
  const first = time(() => wb.recalc());
  const runs: number[] = [];
  for (let k = 0; k < 5; k++) {
    wb.setCell('s', 0, 0, k + 2);
    runs.push(time(() => wb.recalc()).ms);
  }
  return {
    length: N,
    firstRecalcMs: first.ms,
    headEditRecalcMs: median(runs),
    last: wb.getValue('s', N - 1, 0),
  };
}

function mmult() {
  const wb = new Workbook();
  wb.addSheet('s', 'S');
  wb.setSettings({ seed: 1 });
  wb.setCell('s', 0, 0, '=RANDARRAY(256,256)');
  // The scalar input lives in B301 so every edit forces the full 256x256 product again.
  wb.setCell('s', 300, 1, 1);
  wb.setCell('s', 301, 0, '=SUM(MMULT(A1#*B301,A1#))');
  wb.recalc();
  const runs: number[] = [];
  for (let k = 0; k < 15; k++) {
    wb.setCell('s', 300, 1, 1 + k / 100);
    runs.push(time(() => wb.recalc()).ms);
  }
  return {
    size: '256x256 · 256x256',
    recalcMs: median(runs),
    gflops: (2 * 256 ** 3) / (median(runs) / 1000) / 1e9,
  };
}

const report = {
  node: process.version,
  millionCells: millionCells(),
  chain: longChain(),
  mmult: mmult(),
};
console.log(JSON.stringify(report, null, 2));
