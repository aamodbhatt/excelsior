import { compareScalars, toNumber, toText } from '../core/coerce';
import { CellError, Errors } from '../core/errors';
import {
  ArrayValue,
  type Grid,
  LambdaValue,
  NumMatrix,
  RangeRef,
  type Scalar,
  type Value,
  isGrid,
  toNumMatrix,
} from '../core/values';

/** Collapses single cells to scalars; multi-cell references stay grids. Lambdas become #CALC!. */
export function deref(v: Value): Scalar | Grid {
  if (v instanceof RangeRef) return v.isSingleCell() ? v.sheet.getValue(v.r1, v.c1) : v;
  if (v instanceof LambdaValue) return Errors.calc;
  if (v instanceof ArrayValue || v instanceof NumMatrix) {
    return v.rows === 1 && v.cols === 1 ? v.get(0, 0) : v;
  }
  return v;
}

/** Reads a value as a single scalar using Excel's top-left rule for arrays (used by scalar-only slots). */
export function toScalar(v: Value): Scalar {
  const d = deref(v);
  return isGridLike(d) ? d.get(0, 0) : d;
}

export function isGridLike(v: Scalar | Grid): v is Grid {
  return v !== null && typeof v === 'object' && !(v instanceof CellError);
}

/** Result shape of broadcasting two operand shapes (Excel pads mismatches with #N/A). */
function broadcastDim(a: number, b: number): number {
  return a === 1 ? b : b === 1 ? a : Math.max(a, b);
}

function at(g: Grid | Scalar, r: number, c: number): Scalar {
  if (!isGridLike(g)) return g;
  const rr = g.rows === 1 ? 0 : r;
  const cc = g.cols === 1 ? 0 : c;
  if (rr >= g.rows || cc >= g.cols) return Errors.na;
  return g.get(rr, cc);
}

/** Applies a scalar function elementwise over any mix of scalars and grids with Excel broadcasting. */
export function liftN(args: (Scalar | Grid)[], fn: (xs: Scalar[]) => Scalar): Scalar | ArrayValue {
  let rows = 1;
  let cols = 1;
  let anyGrid = false;
  for (const a of args) {
    if (isGridLike(a)) {
      anyGrid = true;
      rows = broadcastDim(rows, a.rows);
      cols = broadcastDim(cols, a.cols);
    }
  }
  if (!anyGrid) return fn(args as Scalar[]);
  const data: Scalar[] = new Array(rows * cols);
  const xs: Scalar[] = new Array(args.length);
  for (let r = 0, i = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++, i++) {
      for (let k = 0; k < args.length; k++) xs[k] = at(args[k], r, c);
      data[i] = fn(xs);
    }
  }
  return new ArrayValue(rows, cols, data);
}

export function lift1(a: Scalar | Grid, fn: (x: Scalar) => Scalar): Scalar | ArrayValue {
  if (!isGridLike(a)) return fn(a);
  const data: Scalar[] = new Array(a.rows * a.cols);
  for (let r = 0, i = 0; r < a.rows; r++) for (let c = 0; c < a.cols; c++, i++) data[i] = fn(a.get(r, c));
  return new ArrayValue(a.rows, a.cols, data);
}

function checkNumber(n: number): number | CellError {
  return Number.isFinite(n) ? n : Errors.num;
}

/** Elementwise numeric function with a Float64Array fast path (used by EXP, LN, TANH, ...). */
export function mapNumeric(v: Value, fn: (x: number) => number): Value {
  const d = deref(v);
  if (!isGridLike(d)) {
    const n = toNumber(d);
    return n instanceof CellError ? n : checkNumber(fn(n));
  }
  const m = toNumMatrix(d);
  if (m) {
    const out = new Float64Array(m.data.length);
    let ok = true;
    for (let i = 0; i < out.length; i++) {
      const y = fn(m.data[i]);
      out[i] = y;
      if (!Number.isFinite(y)) ok = false;
    }
    if (ok) return new NumMatrix(m.rows, m.cols, out);
  }
  return lift1(d, (x) => {
    const n = toNumber(x);
    return n instanceof CellError ? n : checkNumber(fn(n));
  });
}

export type ArithOp = '+' | '-' | '*' | '/' | '^';

function arithScalar(op: ArithOp, a: number, b: number): number | CellError {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return b === 0 ? Errors.div0 : a / b;
    case '^':
      if (a === 0 && b < 0) return Errors.div0;
      return checkNumber(a ** b);
  }
}

function arithElement(op: ArithOp, x: Scalar, y: Scalar): Scalar {
  const a = toNumber(x);
  if (a instanceof CellError) return a;
  const b = toNumber(y);
  if (b instanceof CellError) return b;
  const r = arithScalar(op, a, b);
  return typeof r === 'number' ? checkNumber(r) : r;
}

function numericOperand(v: Scalar | Grid): NumMatrix | null {
  if (typeof v === 'number') return new NumMatrix(1, 1, Float64Array.of(v));
  if (isGridLike(v)) return toNumMatrix(v);
  return null;
}

/** Typed-array kernel for broadcast arithmetic. Returns null if any result is not finite (error path). */
function arithFast(op: ArithOp, a: NumMatrix, b: NumMatrix): NumMatrix | null {
  if (
    (a.rows !== b.rows && a.rows !== 1 && b.rows !== 1) ||
    (a.cols !== b.cols && a.cols !== 1 && b.cols !== 1)
  ) {
    return null;
  }
  const rows = broadcastDim(a.rows, b.rows);
  const cols = broadcastDim(a.cols, b.cols);
  const out = new Float64Array(rows * cols);
  const ad = a.data;
  const bd = b.data;
  const sameShape = a.rows === b.rows && a.cols === b.cols;
  if (sameShape) {
    const n = out.length;
    switch (op) {
      case '+':
        for (let i = 0; i < n; i++) out[i] = ad[i] + bd[i];
        break;
      case '-':
        for (let i = 0; i < n; i++) out[i] = ad[i] - bd[i];
        break;
      case '*':
        for (let i = 0; i < n; i++) out[i] = ad[i] * bd[i];
        break;
      case '/':
        for (let i = 0; i < n; i++) out[i] = ad[i] / bd[i];
        break;
      case '^':
        for (let i = 0; i < n; i++) out[i] = ad[i] ** bd[i];
        break;
    }
  } else {
    const ars = a.rows === 1 ? 0 : a.cols;
    const acs = a.cols === 1 ? 0 : 1;
    const brs = b.rows === 1 ? 0 : b.cols;
    const bcs = b.cols === 1 ? 0 : 1;
    for (let r = 0, i = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++, i++) {
        const x = ad[r * ars + c * acs];
        const y = bd[r * brs + c * bcs];
        switch (op) {
          case '+':
            out[i] = x + y;
            break;
          case '-':
            out[i] = x - y;
            break;
          case '*':
            out[i] = x * y;
            break;
          case '/':
            out[i] = x / y;
            break;
          case '^':
            out[i] = x ** y;
            break;
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i])) return null;
  return new NumMatrix(rows, cols, out);
}

export function arithmetic(op: ArithOp, left: Value, right: Value): Value {
  const a = deref(left);
  const b = deref(right);
  if (!isGridLike(a) && !isGridLike(b)) return arithElement(op, a, b);
  const na = numericOperand(a);
  const nb = na && numericOperand(b);
  if (na && nb) {
    const fast = arithFast(op, na, nb);
    if (fast) return fast;
  }
  return liftN([a, b], ([x, y]) => arithElement(op, x, y));
}

export type CompareOp = '=' | '<>' | '<' | '>' | '<=' | '>=';

function compareElement(op: CompareOp, x: Scalar, y: Scalar): Scalar {
  if (x instanceof CellError) return x;
  if (y instanceof CellError) return y;
  const c = compareScalars(x, y);
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
    case '>=':
      return c >= 0;
  }
}

export function compare(op: CompareOp, left: Value, right: Value): Value {
  return liftN([deref(left), deref(right)], ([x, y]) => compareElement(op, x, y));
}

export function concat(left: Value, right: Value): Value {
  return liftN([deref(left), deref(right)], ([x, y]) => {
    const a = toText(x);
    if (a instanceof CellError) return a;
    const b = toText(y);
    if (b instanceof CellError) return b;
    return a + b;
  });
}

export function negate(v: Value): Value {
  return mapNumeric(v, (x) => -x);
}

export function percent(v: Value): Value {
  return mapNumeric(v, (x) => x / 100);
}

export function unaryPlus(v: Value): Value {
  const d = deref(v);
  return isGridLike(d) ? (d as Value) : d;
}

/** The ':' operator applied to two references: the bounding box on a shared sheet. */
export function rangeUnion(left: Value, right: Value): Value {
  if (!(left instanceof RangeRef) || !(right instanceof RangeRef) || left.sheet !== right.sheet)
    return Errors.value;
  return new RangeRef(
    left.sheet,
    Math.min(left.r1, right.r1),
    Math.min(left.c1, right.c1),
    Math.max(left.r2, right.r2),
    Math.max(left.c2, right.c2),
  );
}

/** The '#' operator: the current spill range of the anchor cell. */
export function spillRange(v: Value): Value {
  if (!(v instanceof RangeRef) || !v.isSingleCell()) return Errors.ref;
  const rect = v.sheet.spillRectOf(v.r1, v.c1);
  if (!rect) return Errors.ref;
  return new RangeRef(v.sheet, rect.r1, rect.c1, rect.r2, rect.c2);
}

/** The '@' operator: implicit intersection with the formula's row or column, else the top-left value. */
export function implicitIntersection(v: Value, row: number, col: number): Value {
  if (v instanceof RangeRef) {
    if (v.isSingleCell()) return v;
    if (v.c1 === v.c2 && row >= v.r1 && row <= v.r2) return v.sheet.getValue(row, v.c1);
    if (v.r1 === v.r2 && col >= v.c1 && col <= v.c2) return v.sheet.getValue(v.r1, col);
    return Errors.value;
  }
  if (isGrid(v)) return v.get(0, 0);
  return v;
}
