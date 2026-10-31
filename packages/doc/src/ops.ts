import { MAX_COLS, MAX_ROWS, parseA1, type CalcSettings, type IterationState } from '@excelsior/engine';
import {
  type CellDoc,
  type CellStyle,
  type ChartDoc,
  type CondFormatDoc,
  type WorkbookDoc,
  emptySheet,
} from './model';

/** A cell patch: `v` null clears the input, `s` null clears the style; absent fields are untouched. */
export interface CellPatch {
  v?: string | null;
  s?: CellStyle | null;
}

/**
 * Document operations. Every edit is one of these; the server totally orders them, so cell-level
 * last-writer-wins needs no transformation and clients converge by replaying the same sequence.
 */
export type Op =
  | { t: 'cells'; sheet: string; cells: Record<string, CellPatch> }
  | { t: 'addSheet'; sheet: string; name: string }
  | { t: 'renameSheet'; sheet: string; name: string }
  | { t: 'colWidth'; sheet: string; col: number; width: number }
  | { t: 'condFormats'; sheet: string; rules: CondFormatDoc[] }
  | { t: 'charts'; sheet: string; charts: ChartDoc[] }
  | { t: 'calc'; calc: CalcSettings }
  | { t: 'iterationState'; state: IterationState | null };

export class OpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OpError';
  }
}

const SHEET_NAME = /^[^\\/?*[\]:']{1,31}$/;
const MAX_INPUT = 32_767;

function sheetIndex(doc: WorkbookDoc, id: string): number {
  const i = doc.sheets.findIndex((s) => s.id === id);
  if (i < 0) throw new OpError(`Unknown sheet '${id}'`);
  return i;
}

/** Throws OpError when an op is malformed or does not apply to this document. */
export function validateOp(doc: WorkbookDoc, op: Op): void {
  switch (op.t) {
    case 'cells': {
      sheetIndex(doc, op.sheet);
      const entries = Object.entries(op.cells);
      if (entries.length > 200_000) throw new OpError('Too many cells in one operation');
      for (const [addr, patch] of entries) {
        const a = parseA1(addr);
        if (!a || a.row >= MAX_ROWS || a.col >= MAX_COLS) throw new OpError(`Bad cell address '${addr}'`);
        if (
          patch.v !== undefined &&
          patch.v !== null &&
          (typeof patch.v !== 'string' || patch.v.length > MAX_INPUT)
        ) {
          throw new OpError(`Bad input for ${addr}`);
        }
      }
      return;
    }
    case 'addSheet':
      if (doc.sheets.some((s) => s.id === op.sheet)) throw new OpError(`Sheet '${op.sheet}' exists`);
      if (
        !SHEET_NAME.test(op.name) ||
        doc.sheets.some((s) => s.name.toUpperCase() === op.name.toUpperCase())
      ) {
        throw new OpError(`Invalid or duplicate sheet name '${op.name}'`);
      }
      return;
    case 'renameSheet':
      sheetIndex(doc, op.sheet);
      if (
        !SHEET_NAME.test(op.name) ||
        doc.sheets.some((s) => s.id !== op.sheet && s.name.toUpperCase() === op.name.toUpperCase())
      ) {
        throw new OpError(`Invalid or duplicate sheet name '${op.name}'`);
      }
      return;
    case 'colWidth':
      sheetIndex(doc, op.sheet);
      if (!(op.col >= 0 && op.col < MAX_COLS && op.width >= 4 && op.width <= 2000))
        throw new OpError('Bad column width');
      return;
    case 'condFormats':
    case 'charts':
      sheetIndex(doc, op.sheet);
      return;
    case 'calc':
      if (!(op.calc.maxIterations >= 1 && op.calc.maxIterations <= 100_000))
        throw new OpError('Bad iteration count');
      return;
    case 'iterationState':
      if (op.state !== null && !Array.isArray(op.state.cells)) throw new OpError('Bad iteration state');
      return;
    default:
      throw new OpError(`Unknown operation '${(op as { t: unknown }).t}'`);
  }
}

/** Applies an op in place. Callers validate first (the server always does). */
export function applyOp(doc: WorkbookDoc, op: Op): void {
  switch (op.t) {
    case 'cells': {
      const sheet = doc.sheets[sheetIndex(doc, op.sheet)];
      for (const [addr, patch] of Object.entries(op.cells)) {
        const cell: CellDoc = { ...sheet.cells[addr] };
        if (patch.v !== undefined) {
          if (patch.v === null || patch.v === '') delete cell.v;
          else cell.v = patch.v;
        }
        if (patch.s !== undefined) {
          if (patch.s === null) delete cell.s;
          else cell.s = patch.s;
        }
        if (cell.v === undefined && cell.s === undefined) delete sheet.cells[addr];
        else sheet.cells[addr] = cell;
      }
      return;
    }
    case 'addSheet':
      doc.sheets.push(emptySheet(op.sheet, op.name));
      return;
    case 'renameSheet':
      doc.sheets[sheetIndex(doc, op.sheet)].name = op.name;
      return;
    case 'colWidth':
      doc.sheets[sheetIndex(doc, op.sheet)].colWidths[String(op.col)] = op.width;
      return;
    case 'condFormats':
      doc.sheets[sheetIndex(doc, op.sheet)].condFormats = op.rules;
      return;
    case 'charts':
      doc.sheets[sheetIndex(doc, op.sheet)].charts = op.charts;
      return;
    case 'calc':
      doc.calc = op.calc;
      return;
    case 'iterationState':
      doc.iterationState = op.state;
      return;
  }
}

/** The op that undoes `op` against the document as it was before applying it (cell edits only). */
export function invertCellsOp(doc: WorkbookDoc, op: Extract<Op, { t: 'cells' }>): Op {
  const sheet = doc.sheets[sheetIndex(doc, op.sheet)];
  const cells: Record<string, CellPatch> = {};
  for (const [addr, patch] of Object.entries(op.cells)) {
    const before = sheet.cells[addr];
    cells[addr] = {
      ...(patch.v !== undefined ? { v: before?.v ?? null } : {}),
      ...(patch.s !== undefined ? { s: before?.s ?? null } : {}),
    };
  }
  return { t: 'cells', sheet: op.sheet, cells };
}

export function cloneDoc(doc: WorkbookDoc): WorkbookDoc {
  return structuredClone(doc);
}
