import type { EvalContext } from '../compile/context';
import { deref, isGridLike, liftN, mapNumeric } from '../compile/ops';
import { compareScalars, parseNumericText, toNumber, toText } from '../core/coerce';
import { CellError, Errors } from '../core/errors';
import { ArrayValue, type Grid, NumMatrix, RangeRef, type Scalar, type Value } from '../core/values';
import type { FunctionCategory, FunctionSpec } from './types';

interface Meta {
  name: string;
  min: number;
  max: number;
  sig: string;
  desc: string;
  cat: FunctionCategory;
  volatile?: boolean;
}

export function define(meta: Meta, call: (args: Value[], ctx: EvalContext) => Value): FunctionSpec {
  return {
    name: meta.name,
    minArgs: meta.min,
    maxArgs: meta.max,
    volatile: meta.volatile,
    signature: meta.sig,
    description: meta.desc,
    category: meta.cat,
    call,
  };
}

/** A function of scalars, automatically lifted over arrays; errors in any argument propagate first. */
export function scalarFn(meta: Meta, impl: (xs: Scalar[]) => Scalar, passErrors = false): FunctionSpec {
  return define(meta, (args) =>
    liftN(args.map(deref), (xs) => {
      if (!passErrors) for (const x of xs) if (x instanceof CellError) return x;
      return impl(xs);
    }),
  );
}

/** A one-argument numeric function with the Float64Array fast path. */
export function numFn(meta: Omit<Meta, 'min' | 'max'>, f: (x: number) => number): FunctionSpec {
  return define({ ...meta, min: 1, max: 1 }, (args) => mapNumeric(args[0], f));
}

export function num(x: Scalar): number | CellError {
  return toNumber(x);
}

export function text(x: Scalar): string | CellError {
  return toText(x);
}

/** Views any argument as a grid (scalars become 1x1). */
export function asGrid(v: Value): Grid | CellError {
  const d = deref(v);
  if (isGridLike(d)) return d;
  if (v instanceof RangeRef) return v;
  return new ArrayValue(1, 1, [d]);
}

/** Returns a single scalar argument, or an error if an array was given where a scalar is required. */
export function scalarArg(v: Value): Scalar {
  const d = deref(v);
  return isGridLike(d) ? Errors.value : d;
}

export function intArg(v: Value, fallback?: number): number | CellError {
  if (v === null && fallback !== undefined) return fallback;
  const s = scalarArg(v);
  if (s === null && fallback !== undefined) return fallback;
  const n = toNumber(s);
  return n instanceof CellError ? n : Math.trunc(n);
}

export function numArg(v: Value, fallback?: number): number | CellError {
  if (v === null && fallback !== undefined) return fallback;
  const n = toNumber(scalarArg(v));
  return n;
}

/**
 * Visits the numbers an aggregate (SUM, AVERAGE, ...) should see: numbers inside references and arrays
 * (text, booleans and blanks there are skipped), and direct scalar arguments coerced like Excel does.
 * Returns the first error encountered, or null.
 */
export function eachNumber(args: Value[], visit: (n: number) => void): CellError | null {
  for (const a of args) {
    if (a instanceof RangeRef) {
      // forEachValue walks the columnar store and skips empty blocks, so whole-column refs stay cheap.
      let err: CellError | null = null;
      a.sheet.forEachValue(a.rect, (v) => {
        if (err) return;
        if (typeof v === 'number') visit(v);
        else if (v instanceof CellError) err = v;
      });
      if (err) return err;
      continue;
    }
    if (a instanceof NumMatrix) {
      for (let i = 0; i < a.data.length; i++) visit(a.data[i]);
      continue;
    }
    if (a instanceof ArrayValue) {
      for (const v of a.data) {
        if (typeof v === 'number') visit(v);
        else if (v instanceof CellError) return v;
      }
      continue;
    }
    if (a === null) continue;
    if (typeof a === 'object' && !(a instanceof CellError)) return Errors.value;
    const n = toNumber(a as Scalar);
    if (n instanceof CellError) return n;
    visit(n);
  }
  return null;
}

/** Collects all numbers an aggregate sees into an array. */
export function collectNumbers(args: Value[]): number[] | CellError {
  const out: number[] = [];
  const err = eachNumber(args, (n) => out.push(n));
  return err ?? out;
}

/** Visits every value of every argument (cells, array elements and scalars) without coercion. */
export function eachValue(args: Value[], visit: (v: Scalar) => void, includeBlanks = false): void {
  for (const a of args) {
    const g = asGrid(a);
    if (g instanceof CellError) {
      visit(g);
      continue;
    }
    if (!includeBlanks && g instanceof RangeRef) {
      g.sheet.forEachValue(g.rect, (v) => visit(v));
      continue;
    }
    for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) visit(g.get(r, c));
  }
}

/** Builds a predicate for COUNTIF-style criteria such as ">=10", "<>x", "a*", or a plain value. */
export function criteriaPredicate(criteria: Scalar): (v: Scalar) => boolean {
  if (typeof criteria !== 'string') {
    return (v) =>
      v !== null &&
      !(v instanceof CellError) &&
      criteria !== null &&
      compareScalars(v, criteria as never) === 0;
  }
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/s.exec(criteria)!;
  const op = m[1] ?? '=';
  const raw = m[2];
  const asNum = parseNumericText(raw);
  const target: Scalar =
    asNum !== null ? asNum : /^(TRUE|FALSE)$/i.test(raw) ? raw.toUpperCase() === 'TRUE' : raw;
  if (typeof target === 'string' && (op === '=' || op === '<>') && /[*?]/.test(target)) {
    const re = new RegExp(
      `^${target
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
      'i',
    );
    return (v) => {
      const ok = typeof v === 'string' && re.test(v);
      return op === '=' ? ok : !ok;
    };
  }
  return (v) => {
    if (v instanceof CellError) return false;
    if (raw === '' && op === '=') return v === null || v === '';
    if (v === null) return op === '<>' ? raw !== '' : false;
    const sameKind = typeof v === typeof target;
    if (!sameKind) return op === '<>';
    const c = compareScalars(v, target);
    switch (op) {
      case '=':
        return c === 0;
      case '<>':
        return c !== 0;
      case '<':
        return c < 0;
      case '>':
        return c > 0;
      case '<=':
        return c <= 0;
      default:
        return c >= 0;
    }
  };
}

/** Builds an array result from a row-major generator. */
export function makeArray(rows: number, cols: number, fill: (r: number, c: number) => Scalar): ArrayValue {
  const data: Scalar[] = new Array(rows * cols);
  for (let r = 0, i = 0; r < rows; r++) for (let c = 0; c < cols; c++, i++) data[i] = fill(r, c);
  return new ArrayValue(rows, cols, data);
}
