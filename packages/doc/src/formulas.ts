import {
  type CellInput,
  type EngineSnapshot,
  MAX_COLS,
  MAX_ROWS,
  type Node,
  parseA1,
  parseFormula,
  printFormula,
} from '@excelsior/engine';
import type { WorkbookDoc } from './model';

function shift(node: Node, dRow: number, dCol: number): Node {
  switch (node.kind) {
    case 'ref': {
      const move = (p: typeof node.start) => ({
        ...p,
        row: p.rowAbs || node.type === 'cols' ? p.row : p.row + dRow,
        col: p.colAbs || node.type === 'rows' ? p.col : p.col + dCol,
      });
      const start = move(node.start);
      const end = move(node.end);
      const bad = [start, end].some((p) => p.row < 0 || p.col < 0 || p.row >= MAX_ROWS || p.col >= MAX_COLS);
      return bad ? { kind: 'error', code: '#REF!' } : { ...node, start, end };
    }
    case 'call':
      return { ...node, args: node.args.map((a) => shift(a, dRow, dCol)) };
    case 'invoke':
      return {
        ...node,
        callee: shift(node.callee, dRow, dCol),
        args: node.args.map((a) => shift(a, dRow, dCol)),
      };
    case 'unary':
    case 'postfix':
      return { ...node, operand: shift(node.operand, dRow, dCol) };
    case 'binary':
      return { ...node, left: shift(node.left, dRow, dCol), right: shift(node.right, dRow, dCol) };
    default:
      return node;
  }
}

/**
 * Moves a cell input by (dRow, dCol) the way copy/paste and the fill handle do: relative references
 * shift, absolute ones stay, and references pushed off the grid become #REF!. Non-formulas are unchanged.
 */
export function translateInput(input: string, dRow: number, dCol: number): string {
  if (!input.startsWith('=') || (dRow === 0 && dCol === 0)) return input;
  try {
    return `=${printFormula(shift(parseFormula(input), dRow, dCol))}`;
  } catch {
    return input;
  }
}

/** Converts a stored input string into what the engine expects. */
export function engineInput(v: string | undefined): CellInput {
  return v === undefined || v === '' ? null : v;
}

/** Everything the calculation worker needs from a document. */
export function toEngineSnapshot(doc: WorkbookDoc): EngineSnapshot {
  return {
    sheets: doc.sheets.map((s) => ({
      id: s.id,
      name: s.name,
      cells: Object.entries(s.cells)
        .filter(([, c]) => c.v !== undefined)
        .map(([addr, c]) => {
          const a = parseA1(addr)!;
          return [a.row, a.col, engineInput(c.v)] as [number, number, CellInput];
        }),
    })),
    names: doc.names,
    settings: doc.calc,
    iterationState: doc.iterationState,
  };
}
