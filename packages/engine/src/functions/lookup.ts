import { deref, isGridLike } from '../compile/ops';
import { compareScalars, scalarsEqual, toBoolean } from '../core/coerce';
import { CellError, Errors } from '../core/errors';
import {
  ArrayValue,
  type Grid,
  LambdaValue,
  NumMatrix,
  RangeRef,
  type Scalar,
  type Value,
} from '../core/values';
import { asGrid, define, intArg, makeArray, scalarArg } from './helpers';
import type { FunctionSpec } from './types';

const cat = 'lookup' as const;

/** Reads a 1-D grid (a single row or column) as a flat list. */
function vector(g: Grid): Scalar[] | null {
  if (g.rows !== 1 && g.cols !== 1) return null;
  const out: Scalar[] = [];
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) out.push(g.get(r, c));
  return out;
}

/**
 * Finds `key` in `list`. matchMode: 0 exact, -1 exact-or-next-smaller, 1 exact-or-next-larger, 2 wildcard.
 * searchMode 1 searches first-to-last, -1 last-to-first. Returns the 0-based index or -1.
 */
function find(list: Scalar[], key: Scalar, matchMode: number, searchMode: number): number {
  let best = -1;
  const n = list.length;
  const wildcard =
    matchMode === 2 && typeof key === 'string'
      ? new RegExp(
          `^${key
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*')
            .replace(/\?/g, '.')}$`,
          'i',
        )
      : null;
  for (let k = 0; k < n; k++) {
    const i = searchMode === -1 ? n - 1 - k : k;
    const v = list[i];
    if (v instanceof CellError || key instanceof CellError) continue;
    if (wildcard) {
      if (typeof v === 'string' && wildcard.test(v)) return i;
      continue;
    }
    if (scalarsEqual(v, key)) return i;
    if (matchMode === 0 || v === null || typeof v !== typeof key) continue;
    const c = compareScalars(v, key as never);
    if (matchMode === -1 && c < 0 && (best < 0 || compareScalars(v, list[best] as never) > 0)) best = i;
    if (matchMode === 1 && c > 0 && (best < 0 || compareScalars(v, list[best] as never) < 0)) best = i;
  }
  return best;
}

/** Legacy approximate MATCH on sorted data: last position whose value is <= key (binary search). */
function approxSorted(list: Scalar[], key: Scalar, descending: boolean): number {
  let lo = 0;
  let hi = list.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const v = list[mid];
    if (v === null || v instanceof CellError || key instanceof CellError) {
      hi = mid - 1;
      continue;
    }
    const c = compareScalars(v, key as never);
    if (descending ? c >= 0 : c <= 0) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function rowOf(g: Grid, r: number): ArrayValue {
  return makeArray(1, g.cols, (_, c) => g.get(r, c));
}

function colOf(g: Grid, c: number): ArrayValue {
  return makeArray(g.rows, 1, (r) => g.get(r, c));
}

function lookupMany(keyArg: Value, f: (key: Scalar) => Value): Value {
  const keys = deref(keyArg);
  if (!isGridLike(keys)) return f(keys);
  return makeArray(keys.rows, keys.cols, (r, c) => {
    const v = f(keys.get(r, c));
    const d = deref(v);
    return isGridLike(d) ? d.get(0, 0) : d;
  });
}

function index(args: Value[]): Value {
  const g = asGrid(args[0]);
  if (g instanceof CellError) return g;
  const rowArg = deref(args[1] ?? null);
  const colArg = deref(args[2] ?? null);
  if (isGridLike(rowArg) || isGridLike(colArg)) {
    // Array arguments gather elements with broadcasting, which is how dynamic-array Excel reshapes.
    const rows = isGridLike(rowArg) ? rowArg : null;
    const cols = isGridLike(colArg) ? colArg : null;
    const R = Math.max(rows?.rows ?? 1, cols?.rows ?? 1);
    const C = Math.max(rows?.cols ?? 1, cols?.cols ?? 1);
    return makeArray(R, C, (r, c) => {
      const rv = rows ? rows.get(rows.rows === 1 ? 0 : r, rows.cols === 1 ? 0 : c) : rowArg;
      const cv = cols ? cols.get(cols.rows === 1 ? 0 : r, cols.cols === 1 ? 0 : c) : colArg;
      let ri = typeof rv === 'number' ? Math.trunc(rv) : rv === null ? 0 : -1;
      let ci = typeof cv === 'number' ? Math.trunc(cv) : cv === null ? 0 : -1;
      // INDEX(vector, k) indexes along the vector, whichever way it points.
      if (g.rows === 1 && cols === null && colArg === null) {
        ci = ri;
        ri = 1;
      } else if (g.cols === 1 && cols === null && colArg === null) ci = 1;
      if (ri < 1 || ci < 1 || ri > g.rows || ci > g.cols) return Errors.ref;
      return g.get(ri - 1, ci - 1);
    });
  }
  let r = rowArg === null ? 0 : intArg(rowArg as Scalar);
  let c = colArg === null ? 0 : intArg(colArg as Scalar);
  if (r instanceof CellError) return r;
  if (c instanceof CellError) return c;
  if (args.length === 2 && g.rows === 1) {
    c = r;
    r = 1;
  }
  if (r < 0 || c < 0 || r > g.rows || c > g.cols) return Errors.ref;
  if (g instanceof RangeRef) {
    const r1 = r === 0 ? g.r1 : g.r1 + r - 1;
    const r2 = r === 0 ? g.r2 : r1;
    const c1 = c === 0 ? g.c1 : g.c1 + c - 1;
    const c2 = c === 0 ? g.c2 : c1;
    return new RangeRef(g.sheet, r1, c1, r2, c2);
  }
  if (r === 0 && c === 0) return g as Value;
  if (r === 0) return colOf(g, c - 1);
  if (c === 0) return rowOf(g, r - 1);
  return g.get(r - 1, c - 1);
}

function match(args: Value[]): Value {
  const g = asGrid(args[1]);
  if (g instanceof CellError) return g;
  const list = vector(g);
  if (!list) return Errors.na;
  const type = args[2] === undefined || args[2] === null ? 1 : intArg(args[2]);
  if (type instanceof CellError) return type;
  return lookupMany(args[0], (key) => {
    const i =
      type === 0
        ? find(list, key, typeof key === 'string' && /[*?]/.test(key) ? 2 : 0, 1)
        : approxSorted(list, key, type < 0);
    return i < 0 ? Errors.na : i + 1;
  });
}

function xmatch(args: Value[]): Value {
  const g = asGrid(args[1]);
  if (g instanceof CellError) return g;
  const list = vector(g);
  if (!list) return Errors.value;
  const mm = intArg(args[2] ?? null, 0);
  const sm = intArg(args[3] ?? null, 1);
  if (mm instanceof CellError) return mm;
  if (sm instanceof CellError) return sm;
  return lookupMany(args[0], (key) => {
    const i = find(list, key, mm, sm < 0 ? -1 : 1);
    return i < 0 ? Errors.na : i + 1;
  });
}

function xlookup(args: Value[]): Value {
  const lookIn = asGrid(args[1]);
  const ret = asGrid(args[2]);
  if (lookIn instanceof CellError) return lookIn;
  if (ret instanceof CellError) return ret;
  const list = vector(lookIn);
  if (!list) return Errors.value;
  const vertical = lookIn.cols === 1;
  const notFound = args[3] ?? null;
  const mm = intArg(args[4] ?? null, 0);
  const sm = intArg(args[5] ?? null, 1);
  if (mm instanceof CellError) return mm;
  if (sm instanceof CellError) return sm;
  const pick = (key: Scalar): Value => {
    const i = find(list, key, mm, sm < 0 ? -1 : 1);
    if (i < 0) return notFound === null ? Errors.na : notFound;
    if (vertical) return ret.rows === 1 ? ret.get(0, 0) : ret.cols === 1 ? ret.get(i, 0) : rowOf(ret, i);
    return ret.cols === 1 ? ret.get(0, 0) : ret.rows === 1 ? ret.get(0, i) : colOf(ret, i);
  };
  const keys = deref(args[0]);
  return isGridLike(keys) ? lookupMany(args[0], pick) : pick(keys);
}

function vhlookup(args: Value[], vertical: boolean): Value {
  const table = asGrid(args[1]);
  if (table instanceof CellError) return table;
  const k = intArg(args[2]);
  if (k instanceof CellError) return k;
  const approx = args[3] === undefined || args[3] === null ? true : toBoolean(scalarArg(args[3]));
  if (approx instanceof CellError) return approx;
  if (k < 1 || k > (vertical ? table.cols : table.rows)) return Errors.ref;
  const list = vertical ? vector(colOf(table, 0))! : vector(rowOf(table, 0))!;
  return lookupMany(args[0], (key) => {
    const i = approx
      ? approxSorted(list, key, false)
      : find(list, key, typeof key === 'string' && /[*?]/.test(key) ? 2 : 0, 1);
    if (i < 0) return Errors.na;
    return vertical ? table.get(i, k - 1) : table.get(k - 1, i);
  });
}

function filter(args: Value[]): Value {
  const g = asGrid(args[0]);
  const inc = asGrid(args[1]);
  if (g instanceof CellError) return g;
  if (inc instanceof CellError) return inc;
  const byRow = inc.cols === 1 && inc.rows === g.rows;
  const byCol = inc.rows === 1 && inc.cols === g.cols;
  if (!byRow && !byCol) return Errors.value;
  const keep: number[] = [];
  const n = byRow ? g.rows : g.cols;
  for (let i = 0; i < n; i++) {
    const v = byRow ? inc.get(i, 0) : inc.get(0, i);
    if (v instanceof CellError) return v;
    const b = toBoolean(v);
    if (b instanceof CellError) return b;
    if (b) keep.push(i);
  }
  if (!keep.length) return args[2] ?? Errors.calc;
  return byRow
    ? makeArray(keep.length, g.cols, (r, c) => g.get(keep[r], c))
    : makeArray(g.rows, keep.length, (r, c) => g.get(r, keep[c]));
}

function sortRows(args: Value[]): Value {
  const g = asGrid(args[0]);
  if (g instanceof CellError) return g;
  const idx = intArg(args[1] ?? null, 1);
  const order = intArg(args[2] ?? null, 1);
  if (idx instanceof CellError) return idx;
  if (order instanceof CellError) return order;
  if (idx < 1 || idx > g.cols) return Errors.value;
  const rows = Array.from({ length: g.rows }, (_, r) => r);
  rows.sort((a, b) => {
    const x = g.get(a, idx - 1);
    const y = g.get(b, idx - 1);
    if (x instanceof CellError || y instanceof CellError) return 0;
    return compareScalars(x, y) * (order < 0 ? -1 : 1);
  });
  return makeArray(g.rows, g.cols, (r, c) => g.get(rows[r], c));
}

function unique(args: Value[]): Value {
  const g = asGrid(args[0]);
  if (g instanceof CellError) return g;
  const seen = new Map<string, number>();
  const keyOf = (r: number) => {
    const parts: string[] = [];
    for (let c = 0; c < g.cols; c++) {
      const v = g.get(r, c);
      parts.push(typeof v === 'string' ? `s${v.toLowerCase()}` : `${typeof v}${String(v)}`);
    }
    return parts.join('\u0000');
  };
  const order: number[] = [];
  for (let r = 0; r < g.rows; r++) {
    const k = keyOf(r);
    if (!seen.has(k)) {
      seen.set(k, r);
      order.push(r);
    }
  }
  return makeArray(order.length, g.cols, (r, c) => g.get(order[r], c));
}

function takeDrop(args: Value[], take: boolean): Value {
  const g = asGrid(args[0]);
  if (g instanceof CellError) return g;
  const rn = args[1] === undefined || args[1] === null ? null : intArg(args[1]);
  const cn = args[2] === undefined || args[2] === null ? null : intArg(args[2]);
  if (rn instanceof CellError) return rn;
  if (cn instanceof CellError) return cn;
  const span = (n: number | null, size: number): [number, number] => {
    if (n === null) return [0, size];
    if (take) return n >= 0 ? [0, Math.min(n, size)] : [Math.max(0, size + n), size];
    return n >= 0 ? [Math.min(n, size), size] : [0, Math.max(0, size + n)];
  };
  const [r0, r1] = span(rn, g.rows);
  const [c0, c1] = span(cn, g.cols);
  if (r1 <= r0 || c1 <= c0) return Errors.calc;
  return makeArray(r1 - r0, c1 - c0, (r, c) => g.get(r0 + r, c0 + c));
}

function stack(args: Value[], vertical: boolean): Value {
  const grids: Grid[] = [];
  for (const a of args) {
    const g = asGrid(a);
    if (g instanceof CellError) return g;
    grids.push(g);
  }
  const R = vertical ? grids.reduce((s, g) => s + g.rows, 0) : Math.max(...grids.map((g) => g.rows));
  const C = vertical ? Math.max(...grids.map((g) => g.cols)) : grids.reduce((s, g) => s + g.cols, 0);
  const data: Scalar[] = new Array(R * C).fill(Errors.na);
  let offset = 0;
  for (const g of grids) {
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const v = g.get(r, c);
        const rr = vertical ? offset + r : r;
        const cc = vertical ? c : offset + c;
        data[rr * C + cc] = v === null ? 0 : v;
      }
    }
    offset += vertical ? g.rows : g.cols;
  }
  return new ArrayValue(R, C, data);
}

function chooseLines(args: Value[], rows: boolean): Value {
  const g = asGrid(args[0]);
  if (g instanceof CellError) return g;
  const picks: number[] = [];
  for (const a of args.slice(1)) {
    const d = deref(a);
    const items = isGridLike(d)
      ? Array.from({ length: d.rows * d.cols }, (_, i) => d.get(Math.floor(i / d.cols), i % d.cols))
      : [d];
    for (const it of items) {
      if (typeof it !== 'number') return Errors.value;
      const n = rows ? g.rows : g.cols;
      const k = Math.trunc(it);
      const i = k < 0 ? n + k : k - 1;
      if (i < 0 || i >= n) return Errors.value;
      picks.push(i);
    }
  }
  return rows
    ? makeArray(picks.length, g.cols, (r, c) => g.get(picks[r], c))
    : makeArray(g.rows, picks.length, (r, c) => g.get(r, picks[c]));
}

function flatten(args: Value[], toColumn: boolean): Value {
  const g = asGrid(args[0]);
  if (g instanceof CellError) return g;
  const out: Scalar[] = [];
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) out.push(g.get(r, c));
  return toColumn ? new ArrayValue(out.length, 1, out) : new ArrayValue(1, out.length, out);
}

function wrapRows(args: Value[]): Value {
  const g = asGrid(args[0]);
  if (g instanceof CellError) return g;
  const w = intArg(args[1]);
  if (w instanceof CellError) return w;
  const items = vector(g);
  if (!items || w < 1) return Errors.value;
  const R = Math.ceil(items.length / w);
  return makeArray(R, w, (r, c) => (r * w + c < items.length ? items[r * w + c] : Errors.na));
}

function lambdaArg(v: Value): LambdaValue | CellError {
  return v instanceof LambdaValue ? v : v instanceof CellError ? v : Errors.value;
}

function scalarResult(v: Value): Scalar {
  const d = deref(v);
  if (isGridLike(d)) return d.rows === 1 && d.cols === 1 ? d.get(0, 0) : Errors.calc;
  return d;
}

export const lookupFunctions: FunctionSpec[] = [
  define(
    {
      name: 'INDEX',
      min: 2,
      max: 3,
      sig: 'INDEX(array, row_num, [column_num])',
      desc: 'Value or reference at a position',
      cat,
    },
    index,
  ),
  define(
    {
      name: 'MATCH',
      min: 2,
      max: 3,
      sig: 'MATCH(lookup_value, lookup_array, [match_type])',
      desc: 'Position of a value',
      cat,
    },
    match,
  ),
  define(
    {
      name: 'XMATCH',
      min: 2,
      max: 4,
      sig: 'XMATCH(lookup_value, lookup_array, [match_mode], [search_mode])',
      desc: 'Position of a value',
      cat,
    },
    xmatch,
  ),
  define(
    {
      name: 'XLOOKUP',
      min: 3,
      max: 6,
      sig: 'XLOOKUP(lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode])',
      desc: 'Looks up a value and returns the matching item',
      cat,
    },
    xlookup,
  ),
  define(
    {
      name: 'VLOOKUP',
      min: 3,
      max: 4,
      sig: 'VLOOKUP(lookup_value, table_array, col_index_num, [range_lookup])',
      desc: 'Vertical lookup',
      cat,
    },
    (a) => vhlookup(a, true),
  ),
  define(
    {
      name: 'HLOOKUP',
      min: 3,
      max: 4,
      sig: 'HLOOKUP(lookup_value, table_array, row_index_num, [range_lookup])',
      desc: 'Horizontal lookup',
      cat,
    },
    (a) => vhlookup(a, false),
  ),
  define({ name: 'ROW', min: 0, max: 1, sig: 'ROW([reference])', desc: 'Row number', cat }, (args, ctx) => {
    const r = args[0];
    if (r === undefined || r === null) return ctx.row + 1;
    if (!(r instanceof RangeRef)) return Errors.value;
    return r.rows === 1
      ? r.r1 + 1
      : new NumMatrix(
          r.rows,
          1,
          Float64Array.from({ length: r.rows }, (_, i) => r.r1 + i + 1),
        );
  }),
  define(
    { name: 'COLUMN', min: 0, max: 1, sig: 'COLUMN([reference])', desc: 'Column number', cat },
    (args, ctx) => {
      const r = args[0];
      if (r === undefined || r === null) return ctx.col + 1;
      if (!(r instanceof RangeRef)) return Errors.value;
      return r.cols === 1
        ? r.c1 + 1
        : new NumMatrix(
            1,
            r.cols,
            Float64Array.from({ length: r.cols }, (_, i) => r.c1 + i + 1),
          );
    },
  ),
  define({ name: 'ROWS', min: 1, max: 1, sig: 'ROWS(array)', desc: 'Number of rows', cat }, (args) => {
    const g = asGrid(args[0]);
    return g instanceof CellError ? g : g.rows;
  }),
  define(
    { name: 'COLUMNS', min: 1, max: 1, sig: 'COLUMNS(array)', desc: 'Number of columns', cat },
    (args) => {
      const g = asGrid(args[0]);
      return g instanceof CellError ? g : g.cols;
    },
  ),
  define(
    {
      name: 'FILTER',
      min: 2,
      max: 3,
      sig: 'FILTER(array, include, [if_empty])',
      desc: 'Keeps rows or columns that match',
      cat: 'array',
    },
    filter,
  ),
  define(
    {
      name: 'SORT',
      min: 1,
      max: 3,
      sig: 'SORT(array, [sort_index], [sort_order])',
      desc: 'Sorts rows',
      cat: 'array',
    },
    sortRows,
  ),
  define(
    { name: 'UNIQUE', min: 1, max: 1, sig: 'UNIQUE(array)', desc: 'Distinct rows', cat: 'array' },
    unique,
  ),
  define(
    {
      name: 'TAKE',
      min: 2,
      max: 3,
      sig: 'TAKE(array, rows, [columns])',
      desc: 'Rows/columns from the start or end',
      cat: 'array',
    },
    (a) => takeDrop(a, true),
  ),
  define(
    {
      name: 'DROP',
      min: 2,
      max: 3,
      sig: 'DROP(array, rows, [columns])',
      desc: 'Removes rows/columns',
      cat: 'array',
    },
    (a) => takeDrop(a, false),
  ),
  define(
    {
      name: 'VSTACK',
      min: 1,
      max: 255,
      sig: 'VSTACK(array1, ...)',
      desc: 'Stacks arrays vertically',
      cat: 'array',
    },
    (a) => stack(a, true),
  ),
  define(
    {
      name: 'HSTACK',
      min: 1,
      max: 255,
      sig: 'HSTACK(array1, ...)',
      desc: 'Stacks arrays horizontally',
      cat: 'array',
    },
    (a) => stack(a, false),
  ),
  define(
    {
      name: 'CHOOSEROWS',
      min: 2,
      max: 255,
      sig: 'CHOOSEROWS(array, row_num1, ...)',
      desc: 'Selects rows',
      cat: 'array',
    },
    (a) => chooseLines(a, true),
  ),
  define(
    {
      name: 'CHOOSECOLS',
      min: 2,
      max: 255,
      sig: 'CHOOSECOLS(array, col_num1, ...)',
      desc: 'Selects columns',
      cat: 'array',
    },
    (a) => chooseLines(a, false),
  ),
  define(
    { name: 'TOCOL', min: 1, max: 1, sig: 'TOCOL(array)', desc: 'Flattens into one column', cat: 'array' },
    (a) => flatten(a, true),
  ),
  define(
    { name: 'TOROW', min: 1, max: 1, sig: 'TOROW(array)', desc: 'Flattens into one row', cat: 'array' },
    (a) => flatten(a, false),
  ),
  define(
    {
      name: 'WRAPROWS',
      min: 2,
      max: 2,
      sig: 'WRAPROWS(vector, wrap_count)',
      desc: 'Wraps a vector into rows',
      cat: 'array',
    },
    wrapRows,
  ),
  define(
    {
      name: 'MAP',
      min: 2,
      max: 255,
      sig: 'MAP(array1, ..., lambda)',
      desc: 'Applies a LAMBDA to each element',
      cat: 'lambda',
    },
    (args) => {
      const fn = lambdaArg(args[args.length - 1]);
      if (fn instanceof CellError) return fn;
      const grids: Grid[] = [];
      for (const a of args.slice(0, -1)) {
        const g = asGrid(a);
        if (g instanceof CellError) return g;
        grids.push(g);
      }
      const [g0] = grids;
      return makeArray(g0.rows, g0.cols, (r, c) => scalarResult(fn.invoke(grids.map((g) => g.get(r, c)))));
    },
  ),
  define(
    {
      name: 'REDUCE',
      min: 3,
      max: 3,
      sig: 'REDUCE(initial_value, array, lambda(accumulator, value))',
      desc: 'Folds an array to one value',
      cat: 'lambda',
    },
    (args) => {
      const fn = lambdaArg(args[2]);
      if (fn instanceof CellError) return fn;
      const g = asGrid(args[1]);
      if (g instanceof CellError) return g;
      let acc: Value = deref(args[0]) as Value;
      for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) acc = fn.invoke([acc, g.get(r, c)]);
      return acc;
    },
  ),
  define(
    {
      name: 'SCAN',
      min: 3,
      max: 3,
      sig: 'SCAN(initial_value, array, lambda(accumulator, value))',
      desc: 'Running fold',
      cat: 'lambda',
    },
    (args) => {
      const fn = lambdaArg(args[2]);
      if (fn instanceof CellError) return fn;
      const g = asGrid(args[1]);
      if (g instanceof CellError) return g;
      let acc: Value = deref(args[0]) as Value;
      return makeArray(g.rows, g.cols, (r, c) => {
        acc = scalarResult(fn.invoke([acc, g.get(r, c)]));
        return acc;
      });
    },
  ),
  ...(['BYROW', 'BYCOL'] as const).map((name) =>
    define(
      {
        name,
        min: 2,
        max: 2,
        sig: `${name}(array, lambda(${name === 'BYROW' ? 'row' : 'column'}))`,
        desc: `Applies a LAMBDA to each ${name === 'BYROW' ? 'row' : 'column'}`,
        cat: 'lambda',
      },
      (args) => {
        const fn = lambdaArg(args[1]);
        if (fn instanceof CellError) return fn;
        const g = asGrid(args[0]);
        if (g instanceof CellError) return g;
        return name === 'BYROW'
          ? makeArray(g.rows, 1, (r) => scalarResult(fn.invoke([rowOf(g, r)])))
          : makeArray(1, g.cols, (_, c) => scalarResult(fn.invoke([colOf(g, c)])));
      },
    ),
  ),
  define(
    {
      name: 'MAKEARRAY',
      min: 3,
      max: 3,
      sig: 'MAKEARRAY(rows, columns, lambda(row, column))',
      desc: 'Builds an array from a LAMBDA',
      cat: 'lambda',
    },
    (args) => {
      const R = intArg(args[0]);
      const C = intArg(args[1]);
      const fn = lambdaArg(args[2]);
      if (R instanceof CellError) return R;
      if (C instanceof CellError) return C;
      if (fn instanceof CellError) return fn;
      if (R < 1 || C < 1) return Errors.calc;
      return makeArray(R, C, (r, c) => scalarResult(fn.invoke([r + 1, c + 1])));
    },
  ),
];
