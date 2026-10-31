import type { Rect } from '../core/address';
import type { CellError } from '../core/errors';
import type { Scalar } from '../core/values';

const BLOCK_BITS = 10;
const BLOCK = 1 << BLOCK_BITS;
const MASK = BLOCK - 1;

enum Tag {
  Empty = 0,
  Number = 1,
  Other = 2,
}

/** What occupies a cell: nothing, a typed constant, a formula anchor, or a value spilled from an anchor. */
export enum CellKind {
  None = 0,
  Constant = 1,
  Formula = 2,
  Spill = 3,
}

/**
 * A column block of 1024 rows. Numbers live in a Float64Array so that range scans and matrix reads are
 * plain typed-array loops; text, booleans and errors go into a lazily allocated side array.
 */
class Block {
  readonly tag = new Uint8Array(BLOCK);
  readonly kind = new Uint8Array(BLOCK);
  readonly num = new Float64Array(BLOCK);
  other: (string | boolean | CellError)[] | null = null;
  used = 0;
}

/** Columnar, block-sparse storage for one sheet's values and cell kinds. */
export class CellStore {
  private readonly columns: (Block | undefined)[][] = [];
  private maxRow = -1;
  private maxCol = -1;

  private block(row: number, col: number): Block | undefined {
    return this.columns[col]?.[row >> BLOCK_BITS];
  }

  private ensureBlock(row: number, col: number): Block {
    let column = this.columns[col];
    if (!column) column = this.columns[col] = [];
    let b = column[row >> BLOCK_BITS];
    if (!b) b = column[row >> BLOCK_BITS] = new Block();
    return b;
  }

  get(row: number, col: number): Scalar {
    const b = this.block(row, col);
    if (!b) return null;
    const i = row & MASK;
    const t = b.tag[i];
    if (t === Tag.Number) return b.num[i];
    if (t === Tag.Empty) return null;
    return b.other![i];
  }

  kind(row: number, col: number): CellKind {
    const b = this.block(row, col);
    return b ? (b.kind[row & MASK] as CellKind) : CellKind.None;
  }

  /** Writes a value and kind. Writing (null, None) frees the slot. */
  set(row: number, col: number, value: Scalar, kind: CellKind): void {
    if (value === null && kind === CellKind.None) {
      const b = this.block(row, col);
      if (!b) return;
      const i = row & MASK;
      if (b.kind[i] !== CellKind.None || b.tag[i] !== Tag.Empty) b.used--;
      b.tag[i] = Tag.Empty;
      b.kind[i] = CellKind.None;
      if (b.other) b.other[i] = undefined as unknown as string;
      if (b.used === 0) this.columns[col]![row >> BLOCK_BITS] = undefined;
      return;
    }
    const b = this.ensureBlock(row, col);
    const i = row & MASK;
    if (b.kind[i] === CellKind.None && b.tag[i] === Tag.Empty) b.used++;
    b.kind[i] = kind;
    if (typeof value === 'number') {
      b.tag[i] = Tag.Number;
      b.num[i] = value;
    } else if (value === null) {
      b.tag[i] = Tag.Empty;
    } else {
      b.tag[i] = Tag.Other;
      if (!b.other) b.other = new Array(BLOCK);
      b.other[i] = value;
    }
    if (row > this.maxRow) this.maxRow = row;
    if (col > this.maxCol) this.maxCol = col;
  }

  /** Overwrites only the value, keeping the kind. Used on the hot path when a formula recalculates. */
  setValue(row: number, col: number, value: Scalar): void {
    const b = this.ensureBlock(row, col);
    const i = row & MASK;
    if (b.kind[i] === CellKind.None && b.tag[i] === Tag.Empty) b.used++;
    if (typeof value === 'number') {
      b.tag[i] = Tag.Number;
      b.num[i] = value;
    } else if (value === null) {
      b.tag[i] = Tag.Empty;
    } else {
      b.tag[i] = Tag.Other;
      if (!b.other) b.other = new Array(BLOCK);
      b.other[i] = value;
    }
  }

  /** Copies a numeric region row-major; returns null as soon as a non-number (other than blank) is found. */
  readNumbers(rect: Rect): Float64Array | null {
    const rows = rect.r2 - rect.r1 + 1;
    const cols = rect.c2 - rect.c1 + 1;
    const out = new Float64Array(rows * cols);
    for (let c = rect.c1; c <= rect.c2; c++) {
      const column = this.columns[c];
      if (!column) continue;
      const oc = c - rect.c1;
      for (let r = rect.r1; r <= rect.r2; ) {
        const b = column[r >> BLOCK_BITS];
        const blockEnd = Math.min(rect.r2, (r | MASK) >>> 0);
        if (!b) {
          r = blockEnd + 1;
          continue;
        }
        for (; r <= blockEnd; r++) {
          const i = r & MASK;
          const t = b.tag[i];
          if (t === Tag.Number) out[(r - rect.r1) * cols + oc] = b.num[i];
          else if (t !== Tag.Empty) return null;
        }
      }
    }
    return out;
  }

  /** Calls `fn` for every non-blank value in the region (column-major order). */
  forEachValue(rect: Rect, fn: (value: Exclude<Scalar, null>, row: number, col: number) => void): void {
    const c2 = Math.min(rect.c2, this.maxCol);
    const r2 = Math.min(rect.r2, this.maxRow);
    for (let c = rect.c1; c <= c2; c++) {
      const column = this.columns[c];
      if (!column) continue;
      for (let r = rect.r1; r <= r2; ) {
        const b = column[r >> BLOCK_BITS];
        const blockEnd = Math.min(r2, (r | MASK) >>> 0);
        if (!b) {
          r = blockEnd + 1;
          continue;
        }
        for (; r <= blockEnd; r++) {
          const i = r & MASK;
          const t = b.tag[i];
          if (t === Tag.Number) fn(b.num[i], r, c);
          else if (t === Tag.Other) fn(b.other![i], r, c);
        }
      }
    }
  }

  /** True if any cell in the region (except one excluded cell) is occupied by an input or a spill. */
  anyOccupied(rect: Rect, exceptRow: number, exceptCol: number): boolean {
    for (let c = rect.c1; c <= rect.c2; c++) {
      const column = this.columns[c];
      if (!column) continue;
      for (let r = rect.r1; r <= rect.r2; r++) {
        const b = column[r >> BLOCK_BITS];
        if (!b) {
          r |= MASK;
          continue;
        }
        if (b.kind[r & MASK] !== CellKind.None && !(r === exceptRow && c === exceptCol)) return true;
      }
    }
    return false;
  }

  get usedRows(): number {
    return this.maxRow + 1;
  }

  get usedCols(): number {
    return this.maxCol + 1;
  }
}
