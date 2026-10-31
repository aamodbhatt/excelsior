import { type Rect, cellKey, rectContains, rectsIntersect } from '../core/address';
import type { FormulaCell, Sheet } from './sheet';

/** Ranges at most this many columns wide are indexed per column; wider ones go to a short scan list. */
const NARROW = 16;

interface RangeEntry {
  readonly rect: Rect;
  readonly key: string;
  readonly formulas: Set<FormulaCell>;
}

/**
 * Range-aware dependency index for one sheet. A range is stored once (deduplicated across all
 * formulas that read it) instead of as one edge per covered cell, so SUM(A1:A1000000) costs O(1)
 * edges. Point lookups consult the column bucket plus the list of wide ranges.
 */
class SheetIndex {
  readonly cells = new Map<number, Set<FormulaCell>>();
  private readonly ranges = new Map<string, RangeEntry>();
  private readonly byCol = new Map<number, Set<RangeEntry>>();
  private readonly wide = new Set<RangeEntry>();

  add(f: FormulaCell, rect: Rect): void {
    if (rect.r1 === rect.r2 && rect.c1 === rect.c2) {
      const k = cellKey(rect.r1, rect.c1);
      let set = this.cells.get(k);
      if (!set) this.cells.set(k, (set = new Set()));
      set.add(f);
      return;
    }
    const key = `${rect.r1},${rect.c1},${rect.r2},${rect.c2}`;
    let entry = this.ranges.get(key);
    if (!entry) {
      entry = { rect, key, formulas: new Set() };
      this.ranges.set(key, entry);
      if (rect.c2 - rect.c1 < NARROW) {
        for (let c = rect.c1; c <= rect.c2; c++) {
          let bucket = this.byCol.get(c);
          if (!bucket) this.byCol.set(c, (bucket = new Set()));
          bucket.add(entry);
        }
      } else this.wide.add(entry);
    }
    entry.formulas.add(f);
  }

  remove(f: FormulaCell, rect: Rect): void {
    if (rect.r1 === rect.r2 && rect.c1 === rect.c2) {
      const k = cellKey(rect.r1, rect.c1);
      const set = this.cells.get(k);
      set?.delete(f);
      if (set && set.size === 0) this.cells.delete(k);
      return;
    }
    const key = `${rect.r1},${rect.c1},${rect.r2},${rect.c2}`;
    const entry = this.ranges.get(key);
    if (!entry) return;
    entry.formulas.delete(f);
    if (entry.formulas.size > 0) return;
    this.ranges.delete(key);
    if (rect.c2 - rect.c1 < NARROW) {
      for (let c = rect.c1; c <= rect.c2; c++) this.byCol.get(c)?.delete(entry);
    } else this.wide.delete(entry);
  }

  forPoint(row: number, col: number, fn: (f: FormulaCell) => void): void {
    const direct = this.cells.get(cellKey(row, col));
    if (direct) for (const f of direct) fn(f);
    const bucket = this.byCol.get(col);
    if (bucket) for (const e of bucket) if (rectContains(e.rect, row, col)) for (const f of e.formulas) fn(f);
    for (const e of this.wide) if (rectContains(e.rect, row, col)) for (const f of e.formulas) fn(f);
  }

  forRect(rect: Rect, fn: (f: FormulaCell) => void): void {
    const area = (rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1);
    if (area <= this.cells.size) {
      for (let r = rect.r1; r <= rect.r2; r++) {
        for (let c = rect.c1; c <= rect.c2; c++) {
          const set = this.cells.get(cellKey(r, c));
          if (set) for (const f of set) fn(f);
        }
      }
    } else {
      for (const [k, set] of this.cells) {
        const r = Math.floor(k / 16384);
        const c = k % 16384;
        if (rectContains(rect, r, c)) for (const f of set) fn(f);
      }
    }
    for (const e of this.ranges.values()) if (rectsIntersect(e.rect, rect)) for (const f of e.formulas) fn(f);
  }
}

/** Maps cells and ranges to the formulas that read them, across all sheets. */
export class DependencyIndex {
  private readonly sheets = new Map<Sheet, SheetIndex>();

  private of(sheet: Sheet): SheetIndex {
    let idx = this.sheets.get(sheet);
    if (!idx) this.sheets.set(sheet, (idx = new SheetIndex()));
    return idx;
  }

  add(f: FormulaCell, sheet: Sheet, rect: Rect): void {
    this.of(sheet).add(f, rect);
  }

  remove(f: FormulaCell, sheet: Sheet, rect: Rect): void {
    this.sheets.get(sheet)?.remove(f, rect);
  }

  /** Visits formulas that read (row, col); a formula may be visited more than once. */
  forEachDependent(sheet: Sheet, row: number, col: number, fn: (f: FormulaCell) => void): void {
    this.sheets.get(sheet)?.forPoint(row, col, fn);
  }

  /** Visits formulas that read any cell of `rect`; a formula may be visited more than once. */
  forEachDependentInRect(sheet: Sheet, rect: Rect, fn: (f: FormulaCell) => void): void {
    this.sheets.get(sheet)?.forRect(rect, fn);
  }

  dropSheet(sheet: Sheet): void {
    this.sheets.delete(sheet);
  }
}
