import { deref, isGridLike } from '../compile/ops';
import { toBoolean } from '../core/coerce';
import { CellError, Errors } from '../core/errors';
import { RangeRef, type Value } from '../core/values';
import { asGrid, collectNumbers, define, eachValue, intArg, scalarFn } from './helpers';
import type { FunctionSpec } from './types';

const cat = 'statistical' as const;

function withNumbers(args: Value[], f: (xs: number[]) => Value): Value {
  const xs = collectNumbers(args);
  return xs instanceof CellError ? xs : f(xs);
}

function variance(xs: number[], sample: boolean): number | CellError {
  const n = xs.length;
  if (n < (sample ? 2 : 1)) return Errors.div0;
  let mean = 0;
  for (const x of xs) mean += x;
  mean /= n;
  let ss = 0;
  for (const x of xs) ss += (x - mean) ** 2;
  return ss / (sample ? n - 1 : n);
}

function kth(args: Value[], largest: boolean): Value {
  const xs = collectNumbers([args[0]]);
  if (xs instanceof CellError) return xs;
  const k = intArg(args[1]);
  if (k instanceof CellError) return k;
  if (k < 1 || k > xs.length) return Errors.num;
  xs.sort((a, b) => (largest ? b - a : a - b));
  return xs[k - 1];
}

function logicalFold(args: Value[], init: boolean, step: (acc: boolean, x: boolean) => boolean): Value {
  let acc = init;
  let seen = false;
  for (const a of args) {
    const d = deref(a);
    if (isGridLike(d)) {
      let err: CellError | null = null;
      eachValue([a], (v) => {
        if (err) return;
        if (v instanceof CellError) err = v;
        else if (typeof v === 'boolean' || typeof v === 'number') {
          acc = step(acc, toBoolean(v) as boolean);
          seen = true;
        }
      });
      if (err) return err;
      continue;
    }
    if (d === null) continue;
    const b = toBoolean(d);
    if (b instanceof CellError) return b;
    acc = step(acc, b);
    seen = true;
  }
  return seen ? acc : Errors.value;
}

export const statFunctions: FunctionSpec[] = [
  define(
    { name: 'AVERAGE', min: 1, max: 255, sig: 'AVERAGE(number1, ...)', desc: 'Arithmetic mean', cat },
    (args) =>
      withNumbers(args, (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : Errors.div0)),
  ),
  define(
    { name: 'COUNT', min: 1, max: 255, sig: 'COUNT(value1, ...)', desc: 'Counts numbers', cat },
    (args) => {
      let n = 0;
      for (const a of args) {
        const d = deref(a);
        if (isGridLike(d)) eachValue([a], (v) => typeof v === 'number' && n++);
        else if (typeof d === 'number') n++;
      }
      return n;
    },
  ),
  define(
    { name: 'COUNTA', min: 1, max: 255, sig: 'COUNTA(value1, ...)', desc: 'Counts non-empty values', cat },
    (args) => {
      let n = 0;
      for (const a of args) {
        const d = deref(a);
        if (isGridLike(d)) eachValue([a], (v) => v !== null && n++);
        else if (d !== null) n++;
      }
      return n;
    },
  ),
  define(
    { name: 'COUNTBLANK', min: 1, max: 1, sig: 'COUNTBLANK(range)', desc: 'Counts empty cells', cat },
    (args) => {
      const g = asGrid(args[0]);
      if (g instanceof CellError) return g;
      let n = 0;
      for (let r = 0; r < g.rows; r++) {
        for (let c = 0; c < g.cols; c++) {
          const v = g.get(r, c);
          if (v === null || v === '') n++;
        }
      }
      return n;
    },
  ),
  define({ name: 'MAX', min: 1, max: 255, sig: 'MAX(number1, ...)', desc: 'Largest number', cat }, (args) =>
    withNumbers(args, (xs) => (xs.length ? xs.reduce((a, b) => (b > a ? b : a), -Infinity) : 0)),
  ),
  define({ name: 'MIN', min: 1, max: 255, sig: 'MIN(number1, ...)', desc: 'Smallest number', cat }, (args) =>
    withNumbers(args, (xs) => (xs.length ? xs.reduce((a, b) => (b < a ? b : a), Infinity) : 0)),
  ),
  define({ name: 'MEDIAN', min: 1, max: 255, sig: 'MEDIAN(number1, ...)', desc: 'Median', cat }, (args) =>
    withNumbers(args, (xs) => {
      if (!xs.length) return Errors.num;
      xs.sort((a, b) => a - b);
      const m = xs.length >> 1;
      return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
    }),
  ),
  ...(['VAR.S', 'VAR'] as const).map((name) =>
    define({ name, min: 1, max: 255, sig: `${name}(number1, ...)`, desc: 'Sample variance', cat }, (args) =>
      withNumbers(args, (xs) => variance(xs, true)),
    ),
  ),
  define(
    { name: 'VAR.P', min: 1, max: 255, sig: 'VAR.P(number1, ...)', desc: 'Population variance', cat },
    (args) => withNumbers(args, (xs) => variance(xs, false)),
  ),
  ...(['STDEV.S', 'STDEV'] as const).map((name) =>
    define(
      { name, min: 1, max: 255, sig: `${name}(number1, ...)`, desc: 'Sample standard deviation', cat },
      (args) =>
        withNumbers(args, (xs) => {
          const v = variance(xs, true);
          return typeof v === 'number' ? Math.sqrt(v) : v;
        }),
    ),
  ),
  define(
    {
      name: 'STDEV.P',
      min: 1,
      max: 255,
      sig: 'STDEV.P(number1, ...)',
      desc: 'Population standard deviation',
      cat,
    },
    (args) =>
      withNumbers(args, (xs) => {
        const v = variance(xs, false);
        return typeof v === 'number' ? Math.sqrt(v) : v;
      }),
  ),
  define({ name: 'LARGE', min: 2, max: 2, sig: 'LARGE(array, k)', desc: 'k-th largest value', cat }, (args) =>
    kth(args, true),
  ),
  define(
    { name: 'SMALL', min: 2, max: 2, sig: 'SMALL(array, k)', desc: 'k-th smallest value', cat },
    (args) => kth(args, false),
  ),
  define(
    { name: 'CORREL', min: 2, max: 2, sig: 'CORREL(array1, array2)', desc: 'Pearson correlation', cat },
    (args) => {
      const a = asGrid(args[0]);
      const b = asGrid(args[1]);
      if (a instanceof CellError) return a;
      if (b instanceof CellError) return b;
      if (a.rows * a.cols !== b.rows * b.cols) return Errors.na;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < a.rows * a.cols; i++) {
        const x = a.get(Math.floor(i / a.cols), i % a.cols);
        const y = b.get(Math.floor(i / b.cols), i % b.cols);
        if (typeof x === 'number' && typeof y === 'number') {
          xs.push(x);
          ys.push(y);
        }
      }
      const n = xs.length;
      if (n < 2) return Errors.div0;
      const mx = xs.reduce((s, x) => s + x, 0) / n;
      const my = ys.reduce((s, y) => s + y, 0) / n;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (ys[i] - my) ** 2;
      }
      return sxx === 0 || syy === 0 ? Errors.div0 : sxy / Math.sqrt(sxx * syy);
    },
  ),
  define(
    {
      name: 'AND',
      min: 1,
      max: 255,
      sig: 'AND(logical1, ...)',
      desc: 'TRUE if all arguments are TRUE',
      cat: 'logical',
    },
    (args) => logicalFold(args, true, (a, x) => a && x),
  ),
  define(
    {
      name: 'OR',
      min: 1,
      max: 255,
      sig: 'OR(logical1, ...)',
      desc: 'TRUE if any argument is TRUE',
      cat: 'logical',
    },
    (args) => logicalFold(args, false, (a, x) => a || x),
  ),
  define(
    { name: 'XOR', min: 1, max: 255, sig: 'XOR(logical1, ...)', desc: 'Exclusive or', cat: 'logical' },
    (args) => logicalFold(args, false, (a, x) => a !== x),
  ),
  scalarFn(
    { name: 'NOT', min: 1, max: 1, sig: 'NOT(logical)', desc: 'Reverses a logical value', cat: 'logical' },
    ([x]) => {
      const b = toBoolean(x);
      return b instanceof CellError ? b : !b;
    },
  ),
  scalarFn(
    {
      name: 'ISBLANK',
      min: 1,
      max: 1,
      sig: 'ISBLANK(value)',
      desc: 'TRUE if the cell is empty',
      cat: 'info',
    },
    ([x]) => x === null,
    true,
  ),
  scalarFn(
    { name: 'ISNUMBER', min: 1, max: 1, sig: 'ISNUMBER(value)', desc: 'TRUE for numbers', cat: 'info' },
    ([x]) => typeof x === 'number',
    true,
  ),
  scalarFn(
    { name: 'ISTEXT', min: 1, max: 1, sig: 'ISTEXT(value)', desc: 'TRUE for text', cat: 'info' },
    ([x]) => typeof x === 'string',
    true,
  ),
  scalarFn(
    { name: 'ISLOGICAL', min: 1, max: 1, sig: 'ISLOGICAL(value)', desc: 'TRUE for booleans', cat: 'info' },
    ([x]) => typeof x === 'boolean',
    true,
  ),
  scalarFn(
    { name: 'ISERROR', min: 1, max: 1, sig: 'ISERROR(value)', desc: 'TRUE for any error', cat: 'info' },
    ([x]) => x instanceof CellError,
    true,
  ),
  scalarFn(
    {
      name: 'ISERR',
      min: 1,
      max: 1,
      sig: 'ISERR(value)',
      desc: 'TRUE for errors other than #N/A',
      cat: 'info',
    },
    ([x]) => x instanceof CellError && x.code !== '#N/A',
    true,
  ),
  scalarFn(
    { name: 'ISNA', min: 1, max: 1, sig: 'ISNA(value)', desc: 'TRUE for #N/A', cat: 'info' },
    ([x]) => x instanceof CellError && x.code === '#N/A',
    true,
  ),
  scalarFn(
    {
      name: 'ERROR.TYPE',
      min: 1,
      max: 1,
      sig: 'ERROR.TYPE(error_val)',
      desc: 'Number of an error',
      cat: 'info',
    },
    ([x]) => (x instanceof CellError ? x.typeNumber : Errors.na),
    true,
  ),
  define({ name: 'NA', min: 0, max: 0, sig: 'NA()', desc: 'The #N/A error', cat: 'info' }, () => Errors.na),
  define(
    {
      name: 'ISREF',
      min: 1,
      max: 1,
      sig: 'ISREF(value)',
      desc: 'TRUE if the value is a reference',
      cat: 'info',
    },
    (args) => args[0] instanceof RangeRef,
  ),
];
