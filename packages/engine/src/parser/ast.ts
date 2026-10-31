import type { ErrorCode } from '../core/errors';

/** One endpoint of a reference, with `$` (absolute) flags kept for printing and relative translation. */
export interface RefPoint {
  row: number;
  col: number;
  rowAbs: boolean;
  colAbs: boolean;
}

/**
 * A reference as written. `cell` is A1, `area` is A1:B2, `cols` is A:C and `rows` is 1:3.
 * Whole-column and whole-row references store the full extent in `start`/`end`.
 */
export interface RefNode {
  kind: 'ref';
  sheet: string | null;
  type: 'cell' | 'area' | 'cols' | 'rows';
  start: RefPoint;
  end: RefPoint;
}

export type BinaryOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>=' | ':';

export type ArrayLiteralItem = number | string | boolean | { error: ErrorCode };

export type Node =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'error'; code: ErrorCode }
  | { kind: 'array'; rows: ArrayLiteralItem[][] }
  | RefNode
  | { kind: 'name'; name: string }
  | { kind: 'call'; name: string; args: Node[] }
  | { kind: 'invoke'; callee: Node; args: Node[] }
  | { kind: 'unary'; op: '+' | '-' | '@'; operand: Node }
  | { kind: 'postfix'; op: '%' | '#'; operand: Node }
  | { kind: 'binary'; op: BinaryOp; left: Node; right: Node }
  | { kind: 'missing' };

/** Binding powers shared by the parser and the printer so that printing inserts exactly the needed parens. */
export const BINARY_POWER: Record<BinaryOp, number> = {
  '=': 10,
  '<>': 10,
  '<': 10,
  '>': 10,
  '<=': 10,
  '>=': 10,
  '&': 20,
  '+': 30,
  '-': 30,
  '*': 40,
  '/': 40,
  '^': 50,
  ':': 80,
};

/** Unary minus binds tighter than ^ in Excel: -2^2 = 4. */
export const PREFIX_POWER = 60;
export const PERCENT_POWER = 70;
export const SPILL_POWER = 90;
