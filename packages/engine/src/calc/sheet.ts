import { type Rect, cellKey, rectContains } from '../core/address';
import type { CompiledFormula, ResolvedDep } from '../compile/compiler';
import type { Scalar, SheetReader } from '../core/values';
import { CellKind, CellStore } from './store';

/** A formula installed in a cell. Scheduler bookkeeping lives in plain fields to avoid Map lookups. */
export class FormulaCell {
  /** Registered precedents (resolved to sheets), kept for unregistering and precedent tracing. */
  deps: { sheet: Sheet; rect: Rect }[] = [];
  /** Range this anchor would like to spill into while blocked; registered as a dependency. */
  spillWatch: Rect | null = null;
  // Scheduler scratch state, valid only while `epoch` equals the scheduler's current epoch.
  epoch = 0;
  local = 0;
  /** Recalc pass in which this formula last reported a changed region. */
  touchedPass = 0;

  constructor(
    readonly id: number,
    readonly sheet: Sheet,
    readonly row: number,
    readonly col: number,
    readonly text: string,
    readonly compiled: CompiledFormula,
    readonly unresolved: ResolvedDep[],
  ) {}
}

/** One worksheet: values, formulas and active spills. */
export class Sheet implements SheetReader {
  readonly store = new CellStore();
  readonly formulas = new Map<number, FormulaCell>();
  /** Active spill ranges keyed by anchor cell key. */
  readonly spills = new Map<number, Rect>();

  constructor(
    readonly id: string,
    public name: string,
    public index: number,
  ) {}

  getValue(row: number, col: number): Scalar {
    return this.store.get(row, col);
  }

  readNumbers(rect: Rect): Float64Array | null {
    return this.store.readNumbers(rect);
  }

  forEachValue(rect: Rect, fn: (value: Exclude<Scalar, null>, row: number, col: number) => void): void {
    this.store.forEachValue(rect, fn);
  }

  spillRectOf(row: number, col: number): Rect | null {
    const key = cellKey(row, col);
    const rect = this.spills.get(key);
    if (rect) return rect;
    return this.formulas.has(key) ? { r1: row, c1: col, r2: row, c2: col } : null;
  }

  /** The anchor formula whose active spill covers (row, col), if the cell is a spilled value. */
  spillOwnerAt(row: number, col: number): FormulaCell | null {
    if (this.store.kind(row, col) !== CellKind.Spill) return null;
    for (const [key, rect] of this.spills) {
      if (rectContains(rect, row, col)) return this.formulas.get(key) ?? null;
    }
    return null;
  }

  /**
   * A spill is blocked by any input cell, or by values spilled from another anchor. Cells already spilled
   * by this anchor (inside `own`) do not block it.
   */
  isSpillBlocked(target: Rect, anchorRow: number, anchorCol: number, own: Rect | undefined): boolean {
    if (!this.store.anyOccupied(target, anchorRow, anchorCol)) return false;
    for (let r = target.r1; r <= target.r2; r++) {
      for (let c = target.c1; c <= target.c2; c++) {
        if (r === anchorRow && c === anchorCol) continue;
        const k = this.store.kind(r, c);
        if (k === CellKind.None) continue;
        if (k === CellKind.Spill && own && rectContains(own, r, c)) continue;
        return true;
      }
    }
    return false;
  }
}
