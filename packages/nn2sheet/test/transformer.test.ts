import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Block, type GptWeights, compileTransformer, loadWorkbook } from '../src';

interface ParityCase {
  prompt: string;
  context: string;
  logits: number[][];
  attention: number[][][][];
  probs: number[];
}

const read = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
const weights: GptWeights = read('names-gpt.json');
const parity: { cases: ParityCase[] } = read('names-gpt-parity.json');
const TOL = 1e-9;

describe('transformer in formulas vs PyTorch (float64)', () => {
  const { doc, layout } = compileTransformer(weights);
  const wb = loadWorkbook(doc);
  wb.recalc();

  const block = (b: Block, rows: number, cols: number): number[][] =>
    Array.from({ length: rows }, (_, r) =>
      Array.from({ length: cols }, (_, c) => wb.getValue('model', b.row + r, b.col + c) as number),
    );

  const maxDiff = (a: number[][], b: number[][]): number => {
    let m = 0;
    a.forEach((row, r) => row.forEach((v, c) => (m = Math.max(m, Math.abs(v - b[r][c])))));
    return m;
  };

  it('has the parameter count it claims', () => {
    expect(weights.params).toBeLessThanOrEqual(50_000);
  });

  it.each(parity.cases.map((c) => [c.prompt || '(empty)', c] as const))(
    'prompt %s matches logits, attention and probabilities',
    (_, c) => {
      wb.setCell('model', 3, 1, c.prompt === '' ? null : c.prompt);
      wb.recalc();
      expect(wb.getValue('model', 4, 1)).toBe(c.context);
      const T = c.context.length;
      const V = weights.vocab.length;
      expect(maxDiff(block(layout.logits, T, V), c.logits)).toBeLessThan(TOL);
      layout.attention.forEach((heads, l) =>
        heads.forEach((att, h) => expect(maxDiff(block(att, T, T), c.attention[l][h])).toBeLessThan(TOL)),
      );
      expect(maxDiff(block(layout.probs, 1, V), [c.probs])).toBeLessThan(TOL);
    },
  );

  it('predicts a plausible next character', () => {
    wb.setCell('model', 3, 1, 'emm');
    wb.recalc();
    const next = wb.getValue('model', 5, 1);
    expect(typeof next).toBe('string');
    expect(weights.vocab).toContain(next as string);
  });
});
