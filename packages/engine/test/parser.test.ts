import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Node, parseFormula, printFormula } from '../src';
import type { RefNode } from '../src/parser/ast';
import { FormulaSyntaxError } from '../src/parser/lexer';

const print = (s: string) => printFormula(parseFormula(s));

describe('parser', () => {
  it.each([
    ['1+2*3', '1+2*3'],
    ['(1+2)*3', '(1+2)*3'],
    ['-2^2', '-2^2'],
    ['-(2^2)', '-(2^2)'],
    ['2^3^2', '2^3^2'],
    ['2^(3^2)', '2^(3^2)'],
    ['1-(2-3)', '1-(2-3)'],
    ['50%*2', '50%*2'],
    ['"a"&"b"="ab"', '"a"&"b"="ab"'],
    ['SUM(A1:B2, $C$3, Sheet2!D4)', 'SUM(A1:B2,$C$3,Sheet2!D4)'],
    ["'My Sheet'!A1", "'My Sheet'!A1"],
    ['A:A', 'A:A'],
    ['$1:$3', '$1:$3'],
    ['A1#*2', 'A1#*2'],
    ['{1,2;3,-4}', '{1,2;3,-4}'],
    ['IF(A1,,2)', 'IF(A1,,2)'],
    ['LAMBDA(x,x+1)(3)', 'LAMBDA(x,x+1)(3)'],
    ['_xlfn.XLOOKUP(1,A1:A3,B1:B3)', 'XLOOKUP(1,A1:A3,B1:B3)'],
    ['LET(_xlpm.x, 2, _xlpm.x*3)', 'LET(x,2,x*3)'],
    ['#DIV/0!', '#DIV/0!'],
    ['1E-7+1.5E+21', '1E-7+1.5E+21'],
  ])('round-trips %s', (input, expected) => {
    expect(print(input)).toBe(expected);
  });

  it('uses Excel precedence: unary minus binds tighter than ^, and ^ is left-associative', () => {
    const neg = parseFormula('-2^2');
    expect(neg.kind).toBe('binary');
    const pow = parseFormula('2^3^2') as Extract<Node, { kind: 'binary' }>;
    expect(pow.left.kind).toBe('binary');
  });

  it.each(['1+', 'SUM(1,', '"abc', '{1,2;3}', 'A1+)', "'Sheet A1"])('rejects %s with a position', (bad) => {
    expect(() => parseFormula(bad)).toThrow(FormulaSyntaxError);
  });
});

// ---------------------------------------------------------------- property: parse(print(ast)) == ast

const point = fc.record({
  row: fc.integer({ min: 0, max: 2000 }),
  col: fc.integer({ min: 0, max: 700 }),
  rowAbs: fc.boolean(),
  colAbs: fc.boolean(),
});

const sheetName = fc.option(fc.constantFrom('Sheet1', 'Data', 'My Sheet', "Bob's", '2024'), { nil: null });

const refNode: fc.Arbitrary<RefNode> = fc.oneof(
  fc
    .record({ sheet: sheetName, start: point })
    .map(({ sheet, start }) => ({ kind: 'ref', sheet, type: 'cell', start, end: start }) as RefNode),
  fc
    .record({ sheet: sheetName, start: point, end: point })
    .map(({ sheet, start, end }) => ({ kind: 'ref', sheet, type: 'area', start, end }) as RefNode),
);

const leaf: fc.Arbitrary<Node> = fc.oneof(
  fc
    .double({ min: 0, max: 1e25, noNaN: true, noDefaultInfinity: true })
    .filter((v) => !Object.is(v, -0))
    .map((value) => ({ kind: 'number', value }) as Node),
  fc.string({ maxLength: 6 }).map((value) => ({ kind: 'string', value }) as Node),
  fc.boolean().map((value) => ({ kind: 'boolean', value }) as Node),
  fc.constantFrom('#N/A', '#DIV/0!', '#VALUE!').map((code) => ({ kind: 'error', code }) as Node),
  fc.constantFrom('rate_x', 'my_name', 'alpha_1').map((name) => ({ kind: 'name', name }) as Node),
  refNode,
);

const { expr } = fc.letrec<{ expr: Node }>((tie) => ({
  expr: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    leaf,
    fc
      .record({
        op: fc.constantFrom('+', '-', '*', '/', '^', '&', '=', '<>', '<', '>', '<=', '>='),
        left: tie('expr'),
        right: tie('expr'),
      })
      .map((n) => ({ kind: 'binary', ...n }) as Node),
    fc
      .record({ op: fc.constantFrom('-', '+'), operand: tie('expr') })
      .map((n) => ({ kind: 'unary', ...n }) as Node),
    tie('expr').map((operand) => ({ kind: 'postfix', op: '%', operand }) as Node),
    fc
      .record({
        name: fc.constantFrom('SUM', 'IF', 'MMULT', 'XLOOKUP'),
        args: fc.array(tie('expr'), { maxLength: 3 }),
      })
      .map((n) => ({ kind: 'call', ...n }) as Node),
  ),
}));

describe('printer/parser round trip', () => {
  it('parse(print(ast)) reproduces any AST', () => {
    fc.assert(
      fc.property(expr, (ast) => {
        const text = printFormula(ast);
        expect(parseFormula(text)).toEqual(ast);
      }),
      { numRuns: 1500 },
    );
  });

  it('print is a fixed point after one round trip', () => {
    fc.assert(
      fc.property(expr, (ast) => {
        const once = printFormula(ast);
        expect(printFormula(parseFormula(once))).toBe(once);
      }),
      { numRuns: 500 },
    );
  });
});
