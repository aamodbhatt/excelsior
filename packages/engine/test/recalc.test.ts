import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Workbook, formatA1 } from '../src';
import { TestBook } from './helpers';

describe('incremental recalculation', () => {
  it('updates only what depends on an edit', () => {
    const b = new TestBook().setMany({ A1: 1, A2: '=A1*2', A3: '=A2+1', B1: 5, B2: '=B1*10' });
    b.recalc();
    b.set('A1', 4);
    const report = b.recalc();
    expect(b.get('A3')).toBe(9);
    expect(report.evaluated).toBe(2);
  });

  it('tracks ranges without per-cell edges', () => {
    const b = new TestBook().set('B1', '=SUM(A1:A100000)');
    b.recalc();
    b.set('A99999', 7);
    expect(b.recalc().evaluated).toBe(1);
    expect(b.get('B1')).toBe(7);
  });

  it('recomputes a 10k-long chain from its head', () => {
    const b = new TestBook().set('A1', 1);
    for (let i = 2; i <= 10_000; i++) b.set(`A${i}`, `=A${i - 1}+1`);
    b.recalc();
    b.set('A1', 100);
    b.recalc();
    expect(b.get('A10000')).toBe(10_099);
  });

  it('resolves cross-sheet references and defined names', () => {
    const b = new TestBook(['S1', 'S2']);
    b.set('A1', 3, 'S1').set('A1', '=S1!A1*Rate', 'S2');
    b.wb.defineName('Rate', '=S1!$B$1');
    b.set('B1', 10, 'S1');
    b.recalc();
    expect(b.get('A1', 'S2')).toBe(30);
    b.set('B1', 2, 'S1');
    b.recalc();
    expect(b.get('A1', 'S2')).toBe(6);
  });

  it('reports #REF! for a missing sheet and recovers when it appears', () => {
    const b = new TestBook().set('A1', '=Later!A1+1');
    b.recalc();
    expect(b.plain('A1')).toBe('#REF!');
    b.wb.addSheet('Later', 'Later');
    b.wb.setCell('Later', 0, 0, 41);
    b.recalc();
    expect(b.plain('A1')).toBe(42);
  });
});

describe('dynamic arrays and spilling', () => {
  it('spills, resizes and clears', () => {
    const b = new TestBook().setMany({ A1: 3, B1: '=SEQUENCE(A1)' });
    b.recalc();
    expect([b.get('B1'), b.get('B2'), b.get('B3'), b.get('B4')]).toEqual([1, 2, 3, null]);
    b.set('A1', 2);
    b.recalc();
    expect([b.get('B2'), b.get('B3')]).toEqual([2, null]);
  });

  it('reports #SPILL! when blocked and recovers when the blocker is cleared', () => {
    const b = new TestBook().setMany({ A1: '=SEQUENCE(3)', A2: 'x' });
    b.recalc();
    expect(b.plain('A1')).toBe('#SPILL!');
    b.set('A2', null);
    b.recalc();
    expect(b.get('A3')).toBe(3);
  });

  it('blocks when someone types into a spilled cell', () => {
    const b = new TestBook().set('A1', '=SEQUENCE(3)');
    b.recalc();
    b.set('A3', 99);
    b.recalc();
    expect(b.plain('A1')).toBe('#SPILL!');
    expect(b.get('A2')).toBe(null);
  });

  it('A1# follows the spill and dependents of spilled cells update', () => {
    const b = new TestBook().setMany({ A1: 4, B1: '=SEQUENCE(A1)', C1: '=SUM(B1#)', D1: '=B3*10' });
    b.recalc();
    expect(b.get('C1')).toBe(10);
    expect(b.get('D1')).toBe(30);
    b.set('A1', 2);
    b.recalc();
    expect(b.get('C1')).toBe(3);
    expect(b.get('D1')).toBe(0);
    b.set('A1', 5);
    b.recalc();
    expect(b.get('C1')).toBe(15);
    expect(b.get('D1')).toBe(30);
  });
});

describe('cycles and iterative calculation', () => {
  it('reports #CIRC! without iteration', () => {
    const b = new TestBook().setMany({ A1: '=B1+1', B1: '=A1+1', C1: '=A1*2' });
    const report = b.recalc();
    expect(report.circular).toBe(true);
    expect(b.plain('A1')).toBe('#CIRC!');
    expect(b.plain('C1')).toBe('#CIRC!');
  });

  it('a self-referencing counter advances one step per iteration', () => {
    const b = new TestBook().set('A1', '=A1+1');
    b.wb.setSettings({ iterative: true, maxIterations: 1, maxChange: 0 });
    b.recalc();
    expect(b.get('A1')).toBe(1);
    b.recalc(5);
    expect(b.get('A1')).toBe(6);
  });

  it('converges a fixed point and stops early on maxChange', () => {
    const b = new TestBook().setMany({ A1: '=COS(A1)' });
    b.wb.setSettings({ iterative: true, maxIterations: 1000, maxChange: 1e-12 });
    const report = b.recalc();
    expect(b.get('A1') as number).toBeCloseTo(0.7390851332151607, 10);
    expect(report.iterations).toBeLessThan(1000);
  });

  it('evaluates a cycle row-major with Gauss-Seidel reads (exact gradient descent)', () => {
    // x <- x - lr * grad, with grad computed below x from the current x: minimizes (x-3)^2.
    const b = new TestBook().setMany({ B1: 0.25, A1: '=IF(C1,0,A1-B1*A2)', A2: '=2*(A1-3)', C1: true });
    b.wb.setSettings({ iterative: true, maxIterations: 1, maxChange: 0 });
    b.recalc();
    expect(b.get('A1')).toBe(0);
    b.set('C1', false);
    b.recalc();
    let x = 0;
    x = x - 0.25 * 2 * (x - 3);
    expect(b.get('A1')).toBe(x);
    b.recalc(10);
    for (let i = 0; i < 10; i++) x = x - 0.25 * 2 * (x - 3);
    expect(b.get('A1')).toBe(x);
    expect(b.get('A2')).toBe(2 * (x - 3));
  });

  it('iteration state round-trips: restoring integrators reproduces every cell', () => {
    const make = () => {
      const b = new TestBook().setMany({
        B1: 0.1,
        A1: '=A1-B1*A2',
        A2: '=2*(A1-3)+0*A3',
        A3: '=A2*A2',
        D1: '=A1+A3',
      });
      b.wb.setSettings({ iterative: true, maxIterations: 1, maxChange: 0 });
      return b;
    };
    const live = make();
    live.recalc(7);
    const state = live.wb.getIterationState();
    // A1 reads itself and A2 reads A3 (below it): both read across a back edge.
    expect(state.cells.map((c) => formatA1(c.row, c.col))).toEqual(['A1', 'A2']);
    const restored = make();
    restored.wb.setIterationState(state);
    for (const a of ['A1', 'A2', 'A3', 'D1']) expect(restored.get(a)).toBe(live.get(a));
    live.recalc(3);
    restored.recalc(3);
    expect(restored.get('D1')).toBe(live.get('D1'));
  });
});

// ---------------------------------------------------------------- property: incremental == full recompute

interface Spec {
  n: number;
  formulas: { kind: 'add' | 'sum' | 'mul'; a: number; b: number }[];
  edits: { cell: number; value: number }[];
}

const spec: fc.Arbitrary<Spec> = fc.integer({ min: 2, max: 30 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    formulas: fc.array(fc.record({ kind: fc.constantFrom('add', 'sum', 'mul'), a: fc.nat(), b: fc.nat() }), {
      minLength: n,
      maxLength: n,
    }),
    edits: fc.array(fc.record({ cell: fc.nat({ max: n - 1 }), value: fc.integer({ min: -9, max: 9 }) }), {
      maxLength: 12,
    }),
  }),
);

/** Column A holds inputs, column B formulas that only read earlier cells (a random DAG). */
function build(s: Spec, inputs: number[]): Workbook {
  const wb = new Workbook();
  wb.addSheet('s', 's');
  for (let i = 0; i < s.n; i++) wb.setCell('s', i, 0, inputs[i]);
  s.formulas.forEach((f, i) => {
    const a = f.a % (i + 1);
    const b = f.b % (i + 1);
    const ref = (k: number, prefer: 'A' | 'B') => (prefer === 'B' && k < i ? `B${k + 1}` : `A${k + 1}`);
    const text =
      f.kind === 'add'
        ? `=${ref(a, 'B')}+${ref(b, 'A')}`
        : f.kind === 'mul'
          ? `=${ref(a, 'B')}*0.5+${ref(b, 'B')}`
          : `=SUM(A1:A${Math.max(a, b) + 1})+${ref(a, 'B')}`;
    wb.setCell('s', i, 1, text);
  });
  return wb;
}

describe('incremental vs full recompute', () => {
  it('agree on random DAGs after random edits', () => {
    fc.assert(
      fc.property(spec, (s) => {
        const inputs = Array.from({ length: s.n }, (_, i) => i + 1);
        const incremental = build(s, inputs);
        incremental.recalc();
        for (const e of s.edits) {
          inputs[e.cell] = e.value;
          incremental.setCell('s', e.cell, 0, e.value);
          incremental.recalc();
        }
        const full = build(s, inputs);
        full.recalc();
        for (let i = 0; i < s.n; i++) expect(incremental.getValue('s', i, 1)).toBe(full.getValue('s', i, 1));
      }),
      { numRuns: 200 },
    );
  });
});
