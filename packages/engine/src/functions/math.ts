import { deref } from '../compile/ops';
import { toNumber } from '../core/coerce';
import { CellError, Errors } from '../core/errors';
import { ArrayValue, NumMatrix, type Scalar, type Value, toNumMatrix } from '../core/values';
import { asGrid, criteriaPredicate, define, eachNumber, intArg, numArg, numFn, scalarFn } from './helpers';
import type { FunctionSpec } from './types';

const cat = 'math' as const;

function roundTo(x: number, digits: number, mode: 'half' | 'up' | 'down'): number {
  const f = 10 ** digits;
  const y = Math.abs(x) * f;
  // Nudge by a relative epsilon so that 2.675 rounds like Excel (decimal intent, not binary value).
  const nudged = y * (1 + Number.EPSILON * 4);
  const r =
    mode === 'half' ? Math.floor(nudged + 0.5) : mode === 'up' ? Math.ceil(y - 1e-9) : Math.floor(nudged);
  return (Math.sign(x) * r) / f;
}

function matmul(a: NumMatrix, b: NumMatrix): NumMatrix {
  const n = a.rows;
  const k = a.cols;
  const m = b.cols;
  const out = new Float64Array(n * m);
  const ad = a.data;
  const bd = b.data;
  // i-k-j loop order streams through rows of B, which is cache-friendly for row-major storage.
  for (let i = 0; i < n; i++) {
    const oi = i * m;
    for (let p = 0; p < k; p++) {
      const aip = ad[i * k + p];
      if (aip === 0) continue;
      const bp = p * m;
      for (let j = 0; j < m; j++) out[oi + j] += aip * bd[bp + j];
    }
  }
  return new NumMatrix(n, m, out);
}

function transpose(v: Value): Value {
  const g = asGrid(v);
  if (g instanceof CellError) return g;
  const m = g instanceof NumMatrix ? g : toNumMatrix(g);
  if (m) {
    const out = new Float64Array(m.data.length);
    for (let r = 0; r < m.rows; r++)
      for (let c = 0; c < m.cols; c++) out[c * m.rows + r] = m.data[r * m.cols + c];
    return new NumMatrix(m.cols, m.rows, out);
  }
  const data: Scalar[] = new Array(g.rows * g.cols);
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const x = g.get(r, c);
      data[c * g.rows + r] = x === null ? 0 : x;
    }
  }
  return new ArrayValue(g.cols, g.rows, data);
}

function sumProduct(args: Value[]): Value {
  const mats: NumMatrix[] = [];
  for (const a of args) {
    const g = asGrid(a);
    if (g instanceof CellError) return g;
    const m = toNumMatrix(g);
    if (m) {
      mats.push(m);
      continue;
    }
    // Non-numeric entries count as zero, errors propagate.
    const data = new Float64Array(g.rows * g.cols);
    for (let r = 0, i = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++, i++) {
        const x = g.get(r, c);
        if (x instanceof CellError) return x;
        data[i] = typeof x === 'number' ? x : 0;
      }
    }
    mats.push(new NumMatrix(g.rows, g.cols, data));
  }
  const [first] = mats;
  if (mats.some((m) => m.rows !== first.rows || m.cols !== first.cols)) return Errors.value;
  let total = 0;
  for (let i = 0; i < first.data.length; i++) {
    let p = 1;
    for (const m of mats) p *= m.data[i];
    total += p;
  }
  return total;
}

function sequence(args: Value[]): Value {
  const rows = intArg(args[0]);
  const cols = intArg(args[1] ?? null, 1);
  const start = numArg(args[2] ?? null, 1);
  const step = numArg(args[3] ?? null, 1);
  for (const x of [rows, cols, start, step]) if (x instanceof CellError) return x;
  const R = rows as number;
  const C = cols as number;
  if (R < 1 || C < 1) return Errors.calc;
  if (R * C > 10_000_000) return Errors.num;
  const out = new Float64Array(R * C);
  for (let i = 0; i < out.length; i++) out[i] = (start as number) + i * (step as number);
  return new NumMatrix(R, C, out);
}

function randArray(args: Value[], ctx: Parameters<FunctionSpec['call']>[1]): Value {
  const rows = intArg(args[0] ?? null, 1);
  const cols = intArg(args[1] ?? null, 1);
  const min = numArg(args[2] ?? null, 0);
  const max = numArg(args[3] ?? null, 1);
  const whole = args[4] ?? null;
  for (const x of [rows, cols, min, max]) if (x instanceof CellError) return x;
  const R = rows as number;
  const C = cols as number;
  const lo = min as number;
  const hi = max as number;
  if (R < 1 || C < 1 || hi < lo) return Errors.value;
  const integer = whole !== null && deref(whole) === true;
  const rand = ctx.host.random(ctx, 0);
  const out = new Float64Array(R * C);
  for (let i = 0; i < out.length; i++) {
    const u = rand();
    out[i] = integer ? Math.floor(lo + u * (Math.floor(hi) - Math.ceil(lo) + 1)) : lo + u * (hi - lo);
  }
  return new NumMatrix(R, C, out);
}

function conditionalAggregate(kind: 'sum' | 'count' | 'average', args: Value[]): Value {
  // (range, criteria, [sum_range]) for *IF; (sum_range, range1, crit1, ...) for *IFS.
  let target: Value;
  const pairs: [Value, Scalar][] = [];
  if (args.length <= 3 && kind !== 'count') {
    pairs.push([args[0], deref(args[1]) as Scalar]);
    target = args[2] ?? args[0];
  } else if (kind === 'count') {
    for (let i = 0; i + 1 < args.length; i += 2) pairs.push([args[i], deref(args[i + 1]) as Scalar]);
    target = args[0];
  } else {
    target = args[0];
    for (let i = 1; i + 1 < args.length; i += 2) pairs.push([args[i], deref(args[i + 1]) as Scalar]);
  }
  const t = asGrid(target);
  if (t instanceof CellError) return t;
  const grids = pairs.map(([r, c]) => ({ g: asGrid(r), p: criteriaPredicate(c) }));
  let sum = 0;
  let count = 0;
  for (let r = 0; r < t.rows; r++) {
    for (let c = 0; c < t.cols; c++) {
      let ok = true;
      for (const { g, p } of grids) {
        if (g instanceof CellError) return g;
        if (!p(r < g.rows && c < g.cols ? g.get(r, c) : null)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (kind === 'count') {
        count++;
        continue;
      }
      const v = t.get(r, c);
      if (v instanceof CellError) return v;
      if (typeof v === 'number') {
        sum += v;
        count++;
      }
    }
  }
  if (kind === 'sum') return sum;
  if (kind === 'count') return count;
  return count === 0 ? Errors.div0 : sum / count;
}

export const mathFunctions: FunctionSpec[] = [
  define(
    { name: 'SUM', min: 1, max: 255, sig: 'SUM(number1, [number2], ...)', desc: 'Adds numbers', cat },
    (args) => {
      let s = 0;
      const err = eachNumber(args, (n) => {
        s += n;
      });
      return err ?? s;
    },
  ),
  define(
    { name: 'PRODUCT', min: 1, max: 255, sig: 'PRODUCT(number1, ...)', desc: 'Multiplies numbers', cat },
    (args) => {
      let p = 1;
      const err = eachNumber(args, (n) => {
        p *= n;
      });
      return err ?? p;
    },
  ),
  define(
    { name: 'SUMSQ', min: 1, max: 255, sig: 'SUMSQ(number1, ...)', desc: 'Sum of squares', cat },
    (args) => {
      let s = 0;
      const err = eachNumber(args, (n) => {
        s += n * n;
      });
      return err ?? s;
    },
  ),
  numFn({ name: 'ABS', sig: 'ABS(number)', desc: 'Absolute value', cat }, Math.abs),
  numFn({ name: 'SIGN', sig: 'SIGN(number)', desc: 'Sign of a number', cat }, Math.sign),
  numFn({ name: 'SQRT', sig: 'SQRT(number)', desc: 'Square root', cat }, Math.sqrt),
  numFn({ name: 'EXP', sig: 'EXP(number)', desc: 'e raised to a power', cat }, Math.exp),
  numFn({ name: 'LN', sig: 'LN(number)', desc: 'Natural logarithm', cat }, (x) =>
    x > 0 ? Math.log(x) : Number.NaN,
  ),
  numFn({ name: 'LOG10', sig: 'LOG10(number)', desc: 'Base-10 logarithm', cat }, (x) =>
    x > 0 ? Math.log10(x) : Number.NaN,
  ),
  numFn({ name: 'SIN', sig: 'SIN(number)', desc: 'Sine', cat }, Math.sin),
  numFn({ name: 'COS', sig: 'COS(number)', desc: 'Cosine', cat }, Math.cos),
  numFn({ name: 'TAN', sig: 'TAN(number)', desc: 'Tangent', cat }, Math.tan),
  numFn({ name: 'ATAN', sig: 'ATAN(number)', desc: 'Arctangent', cat }, Math.atan),
  numFn({ name: 'SINH', sig: 'SINH(number)', desc: 'Hyperbolic sine', cat }, Math.sinh),
  numFn({ name: 'COSH', sig: 'COSH(number)', desc: 'Hyperbolic cosine', cat }, Math.cosh),
  numFn({ name: 'TANH', sig: 'TANH(number)', desc: 'Hyperbolic tangent', cat }, Math.tanh),
  numFn({ name: 'INT', sig: 'INT(number)', desc: 'Rounds down to an integer', cat }, Math.floor),
  numFn(
    { name: 'DEGREES', sig: 'DEGREES(angle)', desc: 'Radians to degrees', cat },
    (x) => (x * 180) / Math.PI,
  ),
  numFn(
    { name: 'RADIANS', sig: 'RADIANS(angle)', desc: 'Degrees to radians', cat },
    (x) => (x * Math.PI) / 180,
  ),
  define({ name: 'PI', min: 0, max: 0, sig: 'PI()', desc: 'The constant pi', cat }, () => Math.PI),
  scalarFn({ name: 'LOG', min: 1, max: 2, sig: 'LOG(number, [base])', desc: 'Logarithm', cat }, ([x, b]) => {
    const n = toNumber(x);
    const base = b === undefined || b === null ? 10 : toNumber(b);
    if (n instanceof CellError) return n;
    if (base instanceof CellError) return base;
    return n > 0 && base > 0 && base !== 1 ? Math.log(n) / Math.log(base) : Errors.num;
  }),
  scalarFn(
    { name: 'POWER', min: 2, max: 2, sig: 'POWER(number, power)', desc: 'Raises to a power', cat },
    ([x, y]) => {
      const a = toNumber(x);
      const b = toNumber(y);
      if (a instanceof CellError) return a;
      if (b instanceof CellError) return b;
      if (a === 0 && b < 0) return Errors.div0;
      const r = a ** b;
      return Number.isFinite(r) ? r : Errors.num;
    },
  ),
  scalarFn(
    { name: 'ATAN2', min: 2, max: 2, sig: 'ATAN2(x_num, y_num)', desc: 'Arctangent of x and y', cat },
    ([x, y]) => {
      const a = toNumber(x);
      const b = toNumber(y);
      if (a instanceof CellError) return a;
      if (b instanceof CellError) return b;
      return a === 0 && b === 0 ? Errors.div0 : Math.atan2(b, a);
    },
  ),
  scalarFn(
    {
      name: 'MOD',
      min: 2,
      max: 2,
      sig: 'MOD(number, divisor)',
      desc: 'Remainder with the sign of the divisor',
      cat,
    },
    ([x, y]) => {
      const a = toNumber(x);
      const b = toNumber(y);
      if (a instanceof CellError) return a;
      if (b instanceof CellError) return b;
      if (b === 0) return Errors.div0;
      return a - b * Math.floor(a / b);
    },
  ),
  scalarFn(
    {
      name: 'ROUND',
      min: 2,
      max: 2,
      sig: 'ROUND(number, num_digits)',
      desc: 'Rounds half away from zero',
      cat,
    },
    ([x, d]) => {
      const a = toNumber(x);
      const b = toNumber(d);
      if (a instanceof CellError) return a;
      if (b instanceof CellError) return b;
      return roundTo(a, Math.trunc(b), 'half');
    },
  ),
  scalarFn(
    {
      name: 'ROUNDUP',
      min: 2,
      max: 2,
      sig: 'ROUNDUP(number, num_digits)',
      desc: 'Rounds away from zero',
      cat,
    },
    ([x, d]) => {
      const a = toNumber(x);
      const b = toNumber(d);
      if (a instanceof CellError) return a;
      if (b instanceof CellError) return b;
      return roundTo(a, Math.trunc(b), 'up');
    },
  ),
  scalarFn(
    {
      name: 'ROUNDDOWN',
      min: 2,
      max: 2,
      sig: 'ROUNDDOWN(number, num_digits)',
      desc: 'Rounds toward zero',
      cat,
    },
    ([x, d]) => {
      const a = toNumber(x);
      const b = toNumber(d);
      if (a instanceof CellError) return a;
      if (b instanceof CellError) return b;
      return roundTo(a, Math.trunc(b), 'down');
    },
  ),
  scalarFn(
    { name: 'TRUNC', min: 1, max: 2, sig: 'TRUNC(number, [num_digits])', desc: 'Truncates toward zero', cat },
    ([x, d]) => {
      const a = toNumber(x);
      const b = d === undefined || d === null ? 0 : toNumber(d);
      if (a instanceof CellError) return a;
      if (b instanceof CellError) return b;
      return roundTo(a, Math.trunc(b), 'down');
    },
  ),
  define(
    {
      name: 'SUMPRODUCT',
      min: 1,
      max: 255,
      sig: 'SUMPRODUCT(array1, [array2], ...)',
      desc: 'Sum of elementwise products',
      cat,
    },
    sumProduct,
  ),
  define(
    { name: 'MMULT', min: 2, max: 2, sig: 'MMULT(array1, array2)', desc: 'Matrix product', cat: 'array' },
    (args) => {
      const a = asGrid(args[0]);
      const b = asGrid(args[1]);
      if (a instanceof CellError) return a;
      if (b instanceof CellError) return b;
      const ma = toNumMatrix(a);
      const mb = toNumMatrix(b);
      if (!ma || !mb || ma.cols !== mb.rows) return Errors.value;
      return matmul(ma, mb);
    },
  ),
  define(
    {
      name: 'TRANSPOSE',
      min: 1,
      max: 1,
      sig: 'TRANSPOSE(array)',
      desc: 'Swaps rows and columns',
      cat: 'array',
    },
    (args) => transpose(args[0]),
  ),
  define(
    {
      name: 'SEQUENCE',
      min: 1,
      max: 4,
      sig: 'SEQUENCE(rows, [columns], [start], [step])',
      desc: 'A sequence of numbers',
      cat: 'array',
    },
    sequence,
  ),
  define(
    {
      name: 'RANDARRAY',
      min: 0,
      max: 5,
      sig: 'RANDARRAY([rows], [columns], [min], [max], [whole_number])',
      desc: 'Random numbers (deterministic per cell when the workbook is seeded)',
      cat: 'array',
      volatile: true,
    },
    randArray,
  ),
  define(
    { name: 'RAND', min: 0, max: 0, sig: 'RAND()', desc: 'A random number in [0, 1)', cat, volatile: true },
    (_a, ctx) => ctx.host.random(ctx, 1)(),
  ),
  define(
    {
      name: 'RANDBETWEEN',
      min: 2,
      max: 2,
      sig: 'RANDBETWEEN(bottom, top)',
      desc: 'A random integer',
      cat,
      volatile: true,
    },
    (args, ctx) => {
      const lo = intArg(args[0]);
      const hi = intArg(args[1]);
      if (lo instanceof CellError) return lo;
      if (hi instanceof CellError) return hi;
      if (hi < lo) return Errors.num;
      return lo + Math.floor(ctx.host.random(ctx, 2)() * (hi - lo + 1));
    },
  ),
  define(
    {
      name: 'SUMIF',
      min: 2,
      max: 3,
      sig: 'SUMIF(range, criteria, [sum_range])',
      desc: 'Sums cells that meet a condition',
      cat,
    },
    (args) => conditionalAggregate('sum', args),
  ),
  define(
    {
      name: 'SUMIFS',
      min: 3,
      max: 255,
      sig: 'SUMIFS(sum_range, criteria_range1, criteria1, ...)',
      desc: 'Sums cells that meet several conditions',
      cat,
    },
    (args) => conditionalAggregate('sum', args.length === 3 ? [args[1], args[2], args[0]] : args),
  ),
  define(
    {
      name: 'COUNTIF',
      min: 2,
      max: 2,
      sig: 'COUNTIF(range, criteria)',
      desc: 'Counts cells that meet a condition',
      cat: 'statistical',
    },
    (args) => conditionalAggregate('count', args),
  ),
  define(
    {
      name: 'COUNTIFS',
      min: 2,
      max: 254,
      sig: 'COUNTIFS(criteria_range1, criteria1, ...)',
      desc: 'Counts cells that meet several conditions',
      cat: 'statistical',
    },
    (args) => conditionalAggregate('count', args),
  ),
  define(
    {
      name: 'AVERAGEIF',
      min: 2,
      max: 3,
      sig: 'AVERAGEIF(range, criteria, [average_range])',
      desc: 'Averages cells that meet a condition',
      cat: 'statistical',
    },
    (args) => conditionalAggregate('average', args),
  ),
];
