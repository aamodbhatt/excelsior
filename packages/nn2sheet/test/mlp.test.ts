import { readFileSync } from 'node:fs';
import { parseA1 } from '@excelsior/engine';
import { describe, expect, it } from 'vitest';
import { compileMlp, loadWorkbook } from '../src';

interface Fixture {
  config: { hidden: number; learning_rate: number; steps: number };
  x: number[][];
  y: number[];
  init: number[];
  loss: number[];
  params: number[][];
}

const fixture: Fixture = JSON.parse(
  readFileSync(new URL('../fixtures/mlp-spiral.json', import.meta.url), 'utf8'),
);
const TOL = 1e-9;

describe('MLP trained by iterative calculation', () => {
  const { doc, layout } = compileMlp({
    x: fixture.x,
    y: fixture.y,
    init: fixture.init,
    hidden: fixture.config.hidden,
    learningRate: fixture.config.learning_rate,
  });
  const wb = loadWorkbook(doc);
  const H = fixture.config.hidden;

  const read = (ref: string): number => {
    const [sheet, addr] = ref.split('!');
    const a = parseA1(addr)!;
    return wb.getValue(sheet === 'Train' ? 'train' : 'net', a.row, a.col) as number;
  };
  const params = (): number[] => {
    const out: number[] = [];
    for (let i = 0; i < H; i++)
      for (let j = 0; j < 4; j++) out.push(wb.getValue('train', layout.neurons.row + i, 1 + j) as number);
    out.push(read(layout.outputBias));
    return out;
  };

  it('starts at the NumPy initial state (step 0)', () => {
    expect(read(layout.step)).toBe(0);
    const p = params();
    p.forEach((v, i) => expect(Math.abs(v - fixture.params[0][i])).toBeLessThan(TOL));
    expect(Math.abs(read(layout.loss) - fixture.loss[0])).toBeLessThan(TOL);
  });

  it('matches the NumPy gradient-descent trajectory step for step', () => {
    let worst = 0;
    for (let k = 1; k <= fixture.config.steps; k++) {
      const report = wb.recalc({ iterations: 1 });
      expect(report.iterations).toBe(1);
      expect(read(layout.step)).toBe(k);
      params().forEach((v, i) => {
        worst = Math.max(worst, Math.abs(v - fixture.params[k][i]));
      });
      worst = Math.max(worst, Math.abs(read(layout.loss) - fixture.loss[k]));
    }
    expect(worst).toBeLessThan(TOL);
    expect(fixture.loss.at(-1)!).toBeLessThan(fixture.loss[0] / 3);
  });

  it('keeps only parameters, step and loss history as iteration state', () => {
    const state = wb.getIterationState();
    const sheets = new Set(state.cells.map((c) => c.sheetId));
    expect(sheets).toEqual(new Set(['train', 'net']));
    // 4H + 1 parameters, the step counter, and one cell per history slot.
    expect(state.cells.length).toBe(4 * H + 1 + 1 + 400);
  });
});
