import type { EvalContext, EvalHost } from '../compile/context';
import {
  type CompiledFormula,
  compileFormula,
  resolveDeps,
  shapeKey,
  toCellResult,
} from '../compile/compiler';
import { MAX_COLS, MAX_ROWS, type Rect, cellKey, formatA1 } from '../core/address';
import { parseNumericText } from '../core/coerce';
import { type EncodedScalar, decodeScalar, encodeScalar } from '../core/encode';
import { CellError, Errors, errorFromCode } from '../core/errors';
import { ArrayValue, type Grid, NumMatrix, type Scalar, type SheetReader, type Value } from '../core/values';
import { parseFormula } from '../parser/parser';
import { DependencyIndex } from './depIndex';
import { hashString, xoshiro128 } from './random';
import { type Schedule, buildSchedule } from './schedule';
import { FormulaCell, Sheet } from './sheet';
import { CellKind } from './store';

/** Workbook-level calculation options, mirroring Excel's File > Options > Formulas. */
export interface CalcSettings {
  /** Allow circular references and resolve them by iteration instead of reporting #CIRC!. */
  iterative: boolean;
  /** Iterations per recalculation when iteration is enabled. */
  maxIterations: number;
  /** Stop early once no value in a cycle changes by more than this. */
  maxChange: number;
  /** When set, RAND/RANDARRAY are deterministic per cell and no longer volatile. */
  seed: number | null;
}

export const DEFAULT_CALC_SETTINGS: CalcSettings = {
  iterative: false,
  maxIterations: 100,
  maxChange: 0.001,
  seed: null,
};

/** What the user typed into a cell: a formula ("=..."), a literal, or null to clear it. */
export type CellInput = string | number | boolean | null;

export interface ChangedRegion {
  sheetId: string;
  rect: Rect;
}

export interface RecalcReport {
  evaluated: number;
  iterations: number;
  elapsedMs: number;
  changed: ChangedRegion[];
  circular: boolean;
}

/** Values of the integrator cells: everything needed to resume or reproduce an iterative computation. */
export interface IterationState {
  cells: { sheetId: string; row: number; col: number; rows: number; cols: number; values: EncodedScalar[] }[];
}

type Mode = 'normal' | 'forced' | 'settle' | 'once';

interface Plan {
  nodes: FormulaCell[];
  succStart: Int32Array;
  succ: Int32Array;
  schedule: Schedule;
}

interface NameDef {
  text: string;
  compiled: CompiledFormula;
}

const MAX_FOLLOW_UP_ROUNDS = 8;

/** Parses a non-formula input the way a spreadsheet does when you type it. */
export function parseLiteral(input: Exclude<CellInput, null>): Scalar {
  if (typeof input !== 'string') return input;
  if (input.startsWith("'")) return input.slice(1);
  const n = parseNumericText(input);
  if (n !== null && input.trim() !== '') return n;
  const upper = input.trim().toUpperCase();
  if (upper === 'TRUE' || upper === 'FALSE') return upper === 'TRUE';
  return errorFromCode(input.trim()) ?? input;
}

function gridValue(g: Grid, r: number, c: number): Scalar {
  const v = g.get(r, c);
  return v === null ? 0 : v;
}

/**
 * The calculation engine: sheets, formulas, a range-aware dependency index, and an incremental
 * scheduler with spill handling, cycle detection and Excel-style iterative calculation.
 */
export class Workbook implements EvalHost {
  private readonly sheetList: Sheet[] = [];
  private readonly sheetsById = new Map<string, Sheet>();
  private readonly sheetsByName = new Map<string, Sheet>();
  private readonly names = new Map<string, NameDef>();
  private readonly nameUsers = new Map<string, Set<FormulaCell>>();
  private readonly index = new DependencyIndex();
  private readonly shapes = new Map<string, CompiledFormula>();
  private readonly pendingFormulas = new Set<FormulaCell>();
  private readonly pendingCells: { sheet: Sheet; row: number; col: number }[] = [];
  private readonly pendingRects: { sheet: Sheet; rect: Rect }[] = [];
  private readonly volatiles = new Set<FormulaCell>();
  private readonly knownCyclic = new Set<FormulaCell>();
  private readonly knownIntegrators = new Set<FormulaCell>();
  private settings: CalcSettings = { ...DEFAULT_CALC_SETTINGS };
  private nextFormulaId = 1;
  private epoch = 0;
  private pass = 0;
  private touched: ChangedRegion[] = [];
  private evaluatedCount = 0;
  private nameDepth = 0;
  /** Total iterations performed since creation (shown in the UI as the iteration counter). */
  iterationCount = 0;

  // ---------------------------------------------------------------- sheets and names

  addSheet(id: string, name: string): void {
    if (this.sheetsById.has(id)) throw new Error(`Sheet id '${id}' already exists`);
    if (this.sheetsByName.has(name.toUpperCase())) throw new Error(`Sheet name '${name}' already exists`);
    const sheet = new Sheet(id, name, this.sheetList.length);
    this.sheetList.push(sheet);
    this.sheetsById.set(id, sheet);
    this.sheetsByName.set(name.toUpperCase(), sheet);
    this.rebindAll();
  }

  renameSheet(id: string, name: string): void {
    const sheet = this.sheet(id);
    const clash = this.sheetsByName.get(name.toUpperCase());
    if (clash && clash !== sheet) throw new Error(`Sheet name '${name}' already exists`);
    this.sheetsByName.delete(sheet.name.toUpperCase());
    sheet.name = name;
    this.sheetsByName.set(name.toUpperCase(), sheet);
    this.rebindAll();
  }

  removeSheet(id: string): void {
    const sheet = this.sheet(id);
    for (const f of [...sheet.formulas.values()]) this.uninstall(f);
    this.sheetList.splice(sheet.index, 1);
    this.sheetList.forEach((s, i) => {
      s.index = i;
    });
    this.sheetsById.delete(id);
    this.sheetsByName.delete(sheet.name.toUpperCase());
    this.index.dropSheet(sheet);
    this.rebindAll();
  }

  get sheets(): readonly SheetReader[] {
    return this.sheetList;
  }

  /** Defines (or with null, removes) a workbook-level name such as `LearningRate = Train!$B$3`. */
  defineName(name: string, formula: string | null): void {
    const key = name.toUpperCase();
    if (formula === null) this.names.delete(key);
    else {
      const ast = parseFormula(formula);
      this.names.set(key, { text: formula, compiled: compileFormula(ast, 0, 0) });
    }
    // Copy first: re-registering re-inserts into the same set, which would revisit it forever.
    for (const f of [...(this.nameUsers.get(key) ?? [])]) {
      this.unregister(f);
      this.register(f);
      this.pendingFormulas.add(f);
    }
  }

  setSettings(patch: Partial<CalcSettings>): void {
    this.settings = { ...this.settings, ...patch };
    for (const f of this.knownCyclic) this.pendingFormulas.add(f);
  }

  getSettings(): CalcSettings {
    return { ...this.settings };
  }

  // ---------------------------------------------------------------- cells

  /** Sets a cell's input. Changes are applied lazily: call recalc() to update values. */
  setCell(sheetId: string, row: number, col: number, input: CellInput): void {
    if (row < 0 || col < 0 || row >= MAX_ROWS || col >= MAX_COLS)
      throw new RangeError(`Cell (${row}, ${col}) is out of bounds`);
    const sheet = this.sheet(sheetId);
    const key = cellKey(row, col);
    const existing = sheet.formulas.get(key);
    if (existing) this.uninstall(existing);
    const kind = sheet.store.kind(row, col);
    const isEmptyInput = input === null || input === '';
    if (kind === CellKind.Spill) {
      // Typing into a spilled cell blocks the spill; its anchor must recalculate to #SPILL!.
      const owner = sheet.spillOwnerAt(row, col);
      if (owner) this.pendingFormulas.add(owner);
      if (isEmptyInput) return;
    }
    if (isEmptyInput) sheet.store.set(row, col, null, CellKind.None);
    else if (typeof input === 'string' && input.startsWith('=') && input.length > 1)
      this.install(sheet, row, col, input);
    else sheet.store.set(row, col, parseLiteral(input as Exclude<CellInput, null>), CellKind.Constant);
    this.pendingCells.push({ sheet, row, col });
  }

  getValue(sheetId: string, row: number, col: number): Scalar {
    return this.sheet(sheetId).store.get(row, col);
  }

  getFormula(sheetId: string, row: number, col: number): string | null {
    return this.sheet(sheetId).formulas.get(cellKey(row, col))?.text ?? null;
  }

  /** Copies a rectangle of values row-major. */
  getRange(sheetId: string, rect: Rect): Scalar[] {
    const sheet = this.sheet(sheetId);
    const out: Scalar[] = [];
    for (let r = rect.r1; r <= rect.r2; r++)
      for (let c = rect.c1; c <= rect.c2; c++) out.push(sheet.store.get(r, c));
    return out;
  }

  usedRange(sheetId: string): { rows: number; cols: number } {
    const s = this.sheet(sheetId).store;
    return { rows: s.usedRows, cols: s.usedCols };
  }

  /** Static precedents of a formula cell, for "trace precedents". */
  precedents(sheetId: string, row: number, col: number): ChangedRegion[] {
    const f = this.sheet(sheetId).formulas.get(cellKey(row, col));
    return f ? f.deps.map((d) => ({ sheetId: d.sheet.id, rect: d.rect })) : [];
  }

  /** Formula cells that read this cell (or its spill), for "trace dependents". */
  dependents(sheetId: string, row: number, col: number): { sheetId: string; row: number; col: number }[] {
    const sheet = this.sheet(sheetId);
    const seen = new Set<FormulaCell>();
    this.index.forEachDependent(sheet, row, col, (f) => seen.add(f));
    const spill = sheet.spills.get(cellKey(row, col));
    if (spill) this.index.forEachDependentInRect(sheet, spill, (f) => seen.add(f));
    return [...seen].map((f) => ({ sheetId: f.sheet.id, row: f.row, col: f.col }));
  }

  // ---------------------------------------------------------------- EvalHost

  sheetByName(name: string): SheetReader | null {
    return this.sheetsByName.get(name.toUpperCase()) ?? null;
  }

  evaluateName(name: string, ctx: EvalContext): Value | null {
    const def = this.names.get(name);
    if (!def) return null;
    if (this.nameDepth > 64) return Errors.circ;
    this.nameDepth++;
    try {
      return def.compiled.thunk({ host: this, sheet: ctx.sheet, row: ctx.row, col: ctx.col, env: null });
    } finally {
      this.nameDepth--;
    }
  }

  random(ctx: EvalContext, stream: number): () => number {
    if (this.settings.seed === null) return Math.random;
    const h = hashString(`${this.settings.seed}|${ctx.sheet.id}|${ctx.row}|${ctx.col}|${stream}`);
    return xoshiro128(h);
  }

  // ---------------------------------------------------------------- recalculation

  /**
   * Recalculates everything affected by edits since the last call. With `iterations`, also forces that
   * many iterations of every circular chain (the "step" button of iterative calculation).
   */
  recalc(opts: { iterations?: number } = {}): RecalcReport {
    const seeds = this.takeSeeds();
    if (!this.isSeeded()) for (const f of this.volatiles) seeds.add(f);
    if (opts.iterations !== undefined) {
      if (this.knownCyclic.size === 0) for (const f of this.allFormulas()) seeds.add(f);
      for (const f of this.knownCyclic) seeds.add(f);
    }
    return this.run(seeds, opts.iterations !== undefined ? 'forced' : 'normal', opts.iterations);
  }

  /** Current iteration state (values of integrator cells). */
  getIterationState(): IterationState {
    if (this.knownIntegrators.size === 0 && this.knownCyclic.size === 0) {
      const plan = this.plan(this.allFormulas());
      this.learnCycles(plan);
    }
    const cells: IterationState['cells'] = [];
    const sorted = [...this.knownIntegrators].sort(
      (a, b) => a.sheet.index - b.sheet.index || a.row - b.row || a.col - b.col,
    );
    for (const f of sorted) {
      const rect = f.sheet.spills.get(cellKey(f.row, f.col)) ?? {
        r1: f.row,
        c1: f.col,
        r2: f.row,
        c2: f.col,
      };
      const values: EncodedScalar[] = [];
      for (let r = rect.r1; r <= rect.r2; r++)
        for (let c = rect.c1; c <= rect.c2; c++) values.push(encodeScalar(f.sheet.store.get(r, c)));
      cells.push({
        sheetId: f.sheet.id,
        row: f.row,
        col: f.col,
        rows: rect.r2 - rect.r1 + 1,
        cols: rect.c2 - rect.c1 + 1,
        values,
      });
    }
    return { cells };
  }

  /**
   * Restores integrator values and recomputes every other cell from them without advancing the
   * iteration. Afterwards the workbook is exactly in the state the snapshot was taken in.
   */
  setIterationState(state: IterationState): RecalcReport {
    this.touched = [];
    this.pass++;
    for (const cell of state.cells) {
      const sheet = this.sheet(cell.sheetId);
      const f = sheet.formulas.get(cellKey(cell.row, cell.col));
      if (!f) continue;
      const values = cell.values.map(decodeScalar);
      const result = cell.rows * cell.cols === 1 ? values[0] : new ArrayValue(cell.rows, cell.cols, values);
      this.writeResult(f, result, null);
    }
    const seeds = this.takeSeeds();
    for (const f of this.allFormulas()) seeds.add(f);
    return this.run(seeds, 'settle', undefined);
  }

  private isSeeded(): boolean {
    return this.settings.seed !== null;
  }

  private *allFormulas(): Iterable<FormulaCell> {
    for (const s of this.sheetList) yield* s.formulas.values();
  }

  private takeSeeds(): Set<FormulaCell> {
    const seeds = new Set(this.pendingFormulas);
    for (const { sheet, row, col } of this.pendingCells) {
      this.index.forEachDependent(sheet, row, col, (f) => seeds.add(f));
      this.touch(sheet, { r1: row, c1: col, r2: row, c2: col });
    }
    for (const { sheet, rect } of this.pendingRects) {
      this.index.forEachDependentInRect(sheet, rect, (f) => seeds.add(f));
      this.touch(sheet, rect);
    }
    // Drop formulas that were overwritten after being marked dirty.
    for (const f of seeds) if (f.sheet.formulas.get(cellKey(f.row, f.col)) !== f) seeds.delete(f);
    this.pendingFormulas.clear();
    this.pendingCells.length = 0;
    this.pendingRects.length = 0;
    return seeds;
  }

  private run(seeds: Set<FormulaCell>, mode: Mode, iterations: number | undefined): RecalcReport {
    const start = performance.now();
    const before = this.iterationCount;
    this.evaluatedCount = 0;
    this.pass++;
    let circular = false;
    let current = seeds;
    for (let round = 0; current.size > 0 && round < MAX_FOLLOW_UP_ROUNDS; round++) {
      const plan = this.plan(current);
      this.learnCycles(plan);
      const extentChanges: { sheet: Sheet; rect: Rect }[] = [];
      circular ||= this.execute(plan, round === 0 ? mode : 'once', iterations, extentChanges);
      const next = new Set<FormulaCell>();
      for (const { sheet, rect } of extentChanges)
        this.index.forEachDependentInRect(sheet, rect, (f) => next.add(f));
      current = next;
    }
    const changed = this.touched;
    this.touched = [];
    return {
      evaluated: this.evaluatedCount,
      iterations: this.iterationCount - before,
      elapsedMs: performance.now() - start,
      changed,
      circular,
    };
  }

  /** Collects every formula reachable from the seeds and builds the evaluation schedule. */
  private plan(seeds: Iterable<FormulaCell>): Plan {
    const epoch = ++this.epoch;
    const nodes: FormulaCell[] = [];
    const visit = (f: FormulaCell): void => {
      if (f.epoch !== epoch) {
        f.epoch = epoch;
        f.local = nodes.length;
        nodes.push(f);
      }
    };
    for (const s of seeds) visit(s);
    const lists: FormulaCell[][] = [];
    for (let i = 0; i < nodes.length; i++) {
      const f = nodes[i];
      const list: FormulaCell[] = [];
      const add = (g: FormulaCell): void => {
        list.push(g);
        visit(g);
      };
      this.index.forEachDependent(f.sheet, f.row, f.col, add);
      const spill = f.sheet.spills.get(cellKey(f.row, f.col));
      if (spill) this.index.forEachDependentInRect(f.sheet, spill, add);
      lists.push(list);
    }
    const n = nodes.length;
    const succStart = new Int32Array(n + 1);
    const lastSeen = new Int32Array(n).fill(-1);
    let total = 0;
    for (let i = 0; i < n; i++) {
      for (const g of lists[i]) {
        if (lastSeen[g.local] !== i) {
          lastSeen[g.local] = i;
          total++;
        }
      }
      succStart[i + 1] = total;
    }
    const succ = new Int32Array(total);
    lastSeen.fill(-1);
    for (let i = 0, k = 0; i < n; i++) {
      for (const g of lists[i]) {
        if (lastSeen[g.local] !== i) {
          lastSeen[g.local] = i;
          succ[k++] = g.local;
        }
      }
    }
    const rank = new Float64Array(n);
    for (let i = 0; i < n; i++)
      rank[i] = nodes[i].sheet.index * 2 ** 35 + cellKey(nodes[i].row, nodes[i].col);
    return { nodes, succStart, succ, schedule: buildSchedule(n, succStart, succ, rank) };
  }

  private learnCycles(plan: Plan): void {
    const { nodes, schedule } = plan;
    for (let i = 0; i < nodes.length; i++) {
      const f = nodes[i];
      if (schedule.cyclic[schedule.scc[i]]) this.knownCyclic.add(f);
      else this.knownCyclic.delete(f);
      if (schedule.integrator[i]) this.knownIntegrators.add(f);
      else this.knownIntegrators.delete(f);
    }
  }

  /** Runs a plan; returns true if it contained a circular reference. */
  private execute(
    plan: Plan,
    mode: Mode,
    iterations: number | undefined,
    extentChanges: { sheet: Sheet; rect: Rect }[],
  ): boolean {
    const { nodes, succStart, succ, schedule } = plan;
    const { order, scc, cyclic, integrator } = schedule;
    const n = nodes.length;
    const anyCyclic = cyclic.some(Boolean);
    if (!anyCyclic) {
      for (let k = 0; k < n; k++) this.evaluate(nodes[order[k]], extentChanges);
      return false;
    }
    if (!this.settings.iterative) {
      for (let k = 0; k < n; k++) {
        const v = order[k];
        if (cyclic[scc[v]]) this.writeResult(nodes[v], Errors.circ, extentChanges);
        else this.evaluate(nodes[v], extentChanges);
      }
      return true;
    }
    if (mode === 'settle' || mode === 'once') {
      for (let k = 0; k < n; k++) {
        const v = order[k];
        if (mode === 'settle' && integrator[v]) continue;
        this.evaluate(nodes[v], extentChanges);
      }
      return true;
    }
    // Region: cyclic formulas and everything downstream of them. Core: the part of the region that
    // feeds an integrator and therefore must run every iteration; the rest runs once at the end.
    const inRegion = new Uint8Array(n);
    for (let k = 0; k < n; k++) {
      const v = order[k];
      if (cyclic[scc[v]]) inRegion[v] = 1;
      if (inRegion[v]) for (let e = succStart[v]; e < succStart[v + 1]; e++) inRegion[succ[e]] = 1;
    }
    const core = new Uint8Array(n);
    for (let k = n - 1; k >= 0; k--) {
      const v = order[k];
      if (!inRegion[v]) continue;
      if (cyclic[scc[v]]) {
        core[v] = 1;
        continue;
      }
      for (let e = succStart[v]; e < succStart[v + 1]; e++) {
        if (core[succ[e]]) {
          core[v] = 1;
          break;
        }
      }
    }
    for (let k = 0; k < n; k++) if (!inRegion[order[k]]) this.evaluate(nodes[order[k]], extentChanges);
    const count = iterations ?? this.settings.maxIterations;
    for (let it = 0; it < count; it++) {
      let maxDelta = 0;
      for (let k = 0; k < n; k++) {
        const v = order[k];
        if (!core[v]) continue;
        const d = this.evaluate(nodes[v], extentChanges);
        if (cyclic[scc[v]] && d > maxDelta) maxDelta = d;
      }
      this.iterationCount++;
      if (iterations === undefined && maxDelta < this.settings.maxChange) break;
    }
    for (let k = 0; k < n; k++) {
      const v = order[k];
      if (inRegion[v] && !core[v]) this.evaluate(nodes[v], extentChanges);
    }
    return true;
  }

  /** Evaluates one formula and stores its result; returns the largest numeric change it caused. */
  private evaluate(f: FormulaCell, extentChanges: { sheet: Sheet; rect: Rect }[]): number {
    this.evaluatedCount++;
    let v: Value;
    try {
      v = f.compiled.thunk({ host: this, sheet: f.sheet, row: f.row, col: f.col, env: null });
    } catch (e) {
      // Deep LAMBDA recursion is the only realistic way to get here; surface it as a cell error.
      v = new CellError('#NUM!', e instanceof Error ? e.message : String(e));
    }
    return this.writeResult(f, toCellResult(v), extentChanges);
  }

  private touch(sheet: Sheet, rect: Rect): void {
    this.touched.push({ sheetId: sheet.id, rect });
  }

  /** Writes a formula result, placing or clearing its spill. Returns the max absolute numeric change. */
  private writeResult(
    f: FormulaCell,
    result: Scalar | Grid,
    extentChanges: { sheet: Sheet; rect: Rect }[] | null,
  ): number {
    const { sheet, row, col } = f;
    const store = sheet.store;
    const key = cellKey(row, col);
    const old = sheet.spills.get(key);
    let delta = 0;
    const isGridResult = result !== null && typeof result === 'object' && !(result instanceof CellError);
    let target: Rect | null = null;
    let value: Scalar = result as Scalar;
    if (isGridResult) {
      const g = result as Grid;
      target = { r1: row, c1: col, r2: row + g.rows - 1, c2: col + g.cols - 1 };
      if (target.r2 >= MAX_ROWS || target.c2 >= MAX_COLS || sheet.isSpillBlocked(target, row, col, old)) {
        this.setSpillWatch(f, target.r2 < MAX_ROWS && target.c2 < MAX_COLS ? target : null);
        target = null;
        value = Errors.spill;
      }
    }
    if (old && (!target || old.r2 !== target.r2 || old.c2 !== target.c2)) {
      // Clear spilled cells that the new result no longer covers.
      for (let r = old.r1; r <= old.r2; r++) {
        for (let c = old.c1; c <= old.c2; c++) {
          if ((r === row && c === col) || (target && r <= target.r2 && c <= target.c2)) continue;
          if (store.kind(r, c) === CellKind.Spill) store.set(r, c, null, CellKind.None);
        }
      }
      sheet.spills.delete(key);
      extentChanges?.push({ sheet, rect: old });
    }
    if (target) {
      if (f.spillWatch) this.setSpillWatch(f, null);
      const g = result as Grid;
      const nm = g instanceof NumMatrix ? g.data : null;
      for (let r = 0; r < g.rows; r++) {
        for (let c = 0; c < g.cols; c++) {
          const x = nm ? nm[r * g.cols + c] : gridValue(g, r, c);
          const prev = store.get(row + r, col + c);
          delta = Math.max(delta, changeOf(prev, x));
          if (r === 0 && c === 0) store.setValue(row, col, x);
          else store.set(row + r, col + c, x, CellKind.Spill);
        }
      }
      if (!old || old.r2 !== target.r2 || old.c2 !== target.c2) extentChanges?.push({ sheet, rect: target });
      sheet.spills.set(key, target);
    } else {
      if (value !== Errors.spill && f.spillWatch) this.setSpillWatch(f, null);
      delta = changeOf(store.get(row, col), value);
      store.setValue(row, col, value);
    }
    if (f.touchedPass !== this.pass) {
      f.touchedPass = this.pass;
      const a = target ?? { r1: row, c1: col, r2: row, c2: col };
      this.touch(
        sheet,
        old ? { r1: row, c1: col, r2: Math.max(a.r2, old.r2), c2: Math.max(a.c2, old.c2) } : a,
      );
    }
    return delta;
  }

  /**
   * A blocked anchor watches its intended spill area so that clearing a blocker re-runs it. The anchor
   * cell itself is excluded (as up to two rects); otherwise the anchor would look self-referential.
   */
  private setSpillWatch(f: FormulaCell, rect: Rect | null): void {
    for (const r of watchRects(f.spillWatch, f.row, f.col)) this.index.remove(f, f.sheet, r);
    f.spillWatch = rect;
    for (const r of watchRects(rect, f.row, f.col)) this.index.add(f, f.sheet, r);
  }

  // ---------------------------------------------------------------- formula installation

  private install(sheet: Sheet, row: number, col: number, text: string): void {
    let compiled: CompiledFormula;
    try {
      const ast = parseFormula(text);
      const key = shapeKey(ast, row, col);
      compiled = this.shapes.get(key) ?? compileFormula(ast, row, col);
      this.shapes.set(key, compiled);
    } catch (e) {
      const err = new CellError('#NAME?', e instanceof Error ? e.message : String(e));
      compiled = { thunk: () => err, deps: [], names: [], volatile: false };
    }
    const f = new FormulaCell(
      this.nextFormulaId++,
      sheet,
      row,
      col,
      text,
      compiled,
      resolveDeps(compiled.deps, row, col),
    );
    sheet.formulas.set(cellKey(row, col), f);
    sheet.store.set(row, col, null, CellKind.Formula);
    this.register(f);
    if (compiled.volatile) this.volatiles.add(f);
    this.pendingFormulas.add(f);
  }

  private uninstall(f: FormulaCell): void {
    const { sheet, row, col } = f;
    this.unregister(f);
    this.setSpillWatch(f, null);
    const key = cellKey(row, col);
    const spill = sheet.spills.get(key);
    if (spill) {
      for (let r = spill.r1; r <= spill.r2; r++) {
        for (let c = spill.c1; c <= spill.c2; c++) {
          if (sheet.store.kind(r, c) === CellKind.Spill) sheet.store.set(r, c, null, CellKind.None);
        }
      }
      sheet.spills.delete(key);
      this.pendingRects.push({ sheet, rect: spill });
    }
    sheet.formulas.delete(key);
    sheet.store.set(row, col, null, CellKind.None);
    this.pendingFormulas.delete(f);
    this.volatiles.delete(f);
    this.knownCyclic.delete(f);
    this.knownIntegrators.delete(f);
  }

  private register(f: FormulaCell): void {
    const add = (sheetName: string | null, rect: Rect): void => {
      const target = sheetName === null ? f.sheet : this.sheetsByName.get(sheetName.toUpperCase());
      if (!target) return;
      f.deps.push({ sheet: target, rect });
      this.index.add(f, target, rect);
    };
    for (const d of f.unresolved) add(d.sheet, d.rect);
    const seen = new Set<string>();
    const addName = (name: string): void => {
      if (seen.has(name)) return;
      seen.add(name);
      let users = this.nameUsers.get(name);
      if (!users) this.nameUsers.set(name, (users = new Set()));
      users.add(f);
      const def = this.names.get(name);
      if (!def) return;
      for (const d of resolveDeps(def.compiled.deps, f.row, f.col)) add(d.sheet, d.rect);
      for (const inner of def.compiled.names) addName(inner);
    };
    for (const name of f.compiled.names) addName(name);
  }

  private unregister(f: FormulaCell): void {
    for (const d of f.deps) this.index.remove(f, d.sheet, d.rect);
    f.deps = [];
    for (const users of this.nameUsers.values()) users.delete(f);
  }

  /** Sheet names changed: re-resolve every cross-sheet reference and recalculate everything. */
  private rebindAll(): void {
    for (const f of this.allFormulas()) {
      this.unregister(f);
      this.register(f);
      this.pendingFormulas.add(f);
    }
  }

  private sheet(id: string): Sheet {
    const s = this.sheetsById.get(id);
    if (!s) throw new Error(`Unknown sheet id '${id}'`);
    return s;
  }

  /** Human-readable address such as `Train!B4`, used in diagnostics. */
  describe(sheetId: string, row: number, col: number): string {
    return `${this.sheet(sheetId).name}!${formatA1(row, col)}`;
  }
}

function watchRects(rect: Rect | null, row: number, col: number): Rect[] {
  if (!rect) return [];
  const out: Rect[] = [];
  if (rect.c2 > col) out.push({ r1: row, c1: col + 1, r2: row, c2: rect.c2 });
  if (rect.r2 > row) out.push({ r1: row + 1, c1: col, r2: rect.r2, c2: rect.c2 });
  return out;
}

function changeOf(prev: Scalar, next: Scalar): number {
  if (typeof prev === 'number' && typeof next === 'number') return Math.abs(next - prev);
  if (prev === next) return 0;
  if (prev instanceof CellError && next instanceof CellError && prev.code === next.code) return 0;
  return Number.POSITIVE_INFINITY;
}
