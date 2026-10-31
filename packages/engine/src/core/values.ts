import type { Rect } from './address';
import { CellError } from './errors';

/** A single cell value. `null` is a blank cell. */
export type Scalar = number | string | boolean | CellError | null;

/** Read-only two-dimensional view of values: arrays, numeric matrices and range views all implement it. */
export interface Grid {
  readonly rows: number;
  readonly cols: number;
  get(row: number, col: number): Scalar;
}

/** A materialized array of arbitrary scalars, row-major. */
export class ArrayValue implements Grid {
  constructor(
    readonly rows: number,
    readonly cols: number,
    readonly data: Scalar[],
  ) {}

  get(row: number, col: number): Scalar {
    return this.data[row * this.cols + col];
  }

  static fromRows(rows: Scalar[][]): ArrayValue {
    const cols = rows[0]?.length ?? 0;
    const data: Scalar[] = [];
    for (const r of rows) for (const v of r) data.push(v);
    return new ArrayValue(rows.length, cols, data);
  }
}

/**
 * A dense all-number matrix backed by a Float64Array. Arithmetic and matrix functions keep results in
 * this representation so that training workloads never box individual numbers.
 */
export class NumMatrix implements Grid {
  constructor(
    readonly rows: number,
    readonly cols: number,
    readonly data: Float64Array,
  ) {}

  get(row: number, col: number): number {
    return this.data[row * this.cols + col];
  }
}

/** The minimal view of a sheet that a reference needs in order to read values. */
export interface SheetReader {
  readonly id: string;
  readonly name: string;
  getValue(row: number, col: number): Scalar;
  /** Copies the region into a Float64Array, or returns null if any cell is not a number (blanks -> 0). */
  readNumbers(rect: Rect): Float64Array | null;
  /** Visits every non-blank value in the region. */
  forEachValue(rect: Rect, fn: (value: Exclude<Scalar, null>, row: number, col: number) => void): void;
  /** The region currently covered by the spill anchored at (row, col), or null. */
  spillRectOf(row: number, col: number): Rect | null;
}

/** A reference to a rectangular region. It stays lazy until a function asks for values. */
export class RangeRef implements Grid {
  constructor(
    readonly sheet: SheetReader,
    readonly r1: number,
    readonly c1: number,
    readonly r2: number,
    readonly c2: number,
  ) {}

  get rows(): number {
    return this.r2 - this.r1 + 1;
  }

  get cols(): number {
    return this.c2 - this.c1 + 1;
  }

  get(row: number, col: number): Scalar {
    return this.sheet.getValue(this.r1 + row, this.c1 + col);
  }

  get rect(): Rect {
    return { r1: this.r1, c1: this.c1, r2: this.r2, c2: this.c2 };
  }

  isSingleCell(): boolean {
    return this.r1 === this.r2 && this.c1 === this.c2;
  }
}

/** A callable produced by LAMBDA. */
export class LambdaValue {
  constructor(
    readonly arity: number,
    readonly invoke: (args: Value[]) => Value,
  ) {}
}

/** Anything an expression can evaluate to. */
export type Value = Scalar | ArrayValue | NumMatrix | RangeRef | LambdaValue;

export type GridValue = ArrayValue | NumMatrix | RangeRef;

export function isGrid(v: Value): v is GridValue {
  return v instanceof ArrayValue || v instanceof NumMatrix || v instanceof RangeRef;
}

export function isError(v: unknown): v is CellError {
  return v instanceof CellError;
}

/** Materializes any grid into a NumMatrix if it holds only numbers (blanks count as 0); else null. */
export function toNumMatrix(g: Grid): NumMatrix | null {
  if (g instanceof NumMatrix) return g;
  if (g instanceof RangeRef) {
    const data = g.sheet.readNumbers(g.rect);
    return data ? new NumMatrix(g.rows, g.cols, data) : null;
  }
  const out = new Float64Array(g.rows * g.cols);
  for (let r = 0, i = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++, i++) {
      const v = g.get(r, c);
      if (typeof v === 'number') out[i] = v;
      else if (v === null) out[i] = 0;
      else return null;
    }
  }
  return new NumMatrix(g.rows, g.cols, out);
}

/** Copies any grid into an ArrayValue. */
export function toArrayValue(g: Grid): ArrayValue {
  if (g instanceof ArrayValue) return g;
  const data: Scalar[] = new Array(g.rows * g.cols);
  for (let r = 0, i = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++, i++) data[i] = g.get(r, c);
  return new ArrayValue(g.rows, g.cols, data);
}
