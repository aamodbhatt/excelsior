import { colToLetters } from '../core/address';
import {
  type ArrayLiteralItem,
  BINARY_POWER,
  type Node,
  PERCENT_POWER,
  PREFIX_POWER,
  type RefNode,
  type RefPoint,
  SPILL_POWER,
} from './ast';

const ATOMIC = 1000;

function power(node: Node): number {
  switch (node.kind) {
    case 'binary':
      return BINARY_POWER[node.op];
    case 'unary':
      return node.op === '@' ? BINARY_POWER[':'] : PREFIX_POWER;
    case 'postfix':
      return node.op === '%' ? PERCENT_POWER : SPILL_POWER;
    default:
      return ATOMIC;
  }
}

const PLAIN_SHEET = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function formatSheetName(name: string): string {
  return PLAIN_SHEET.test(name) ? name : `'${name.replace(/'/g, "''")}'`;
}

function printNumber(n: number): string {
  // Shortest round-trip representation; Excel accepts the same exponent syntax.
  return String(n).toUpperCase();
}

function printPoint(p: RefPoint, part: 'cell' | 'col' | 'row'): string {
  const col = (p.colAbs ? '$' : '') + colToLetters(p.col);
  const row = (p.rowAbs ? '$' : '') + (p.row + 1);
  if (part === 'col') return col;
  if (part === 'row') return row;
  return col + row;
}

export function printRef(ref: RefNode): string {
  const prefix = ref.sheet === null ? '' : `${formatSheetName(ref.sheet)}!`;
  switch (ref.type) {
    case 'cell':
      return prefix + printPoint(ref.start, 'cell');
    case 'area':
      return `${prefix}${printPoint(ref.start, 'cell')}:${printPoint(ref.end, 'cell')}`;
    case 'cols':
      return `${prefix}${printPoint(ref.start, 'col')}:${printPoint(ref.end, 'col')}`;
    case 'rows':
      return `${prefix}${printPoint(ref.start, 'row')}:${printPoint(ref.end, 'row')}`;
  }
}

function printString(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

function printArrayItem(item: ArrayLiteralItem): string {
  if (typeof item === 'number') return printNumber(item);
  if (typeof item === 'string') return printString(item);
  if (typeof item === 'boolean') return item ? 'TRUE' : 'FALSE';
  return item.error;
}

function wrap(node: Node, needParens: boolean): string {
  const s = print(node);
  return needParens ? `(${s})` : s;
}

function print(node: Node): string {
  switch (node.kind) {
    case 'number':
      return printNumber(node.value);
    case 'string':
      return printString(node.value);
    case 'boolean':
      return node.value ? 'TRUE' : 'FALSE';
    case 'error':
      return node.code;
    case 'missing':
      return '';
    case 'array':
      return `{${node.rows.map((r) => r.map(printArrayItem).join(',')).join(';')}}`;
    case 'ref':
      return printRef(node);
    case 'name':
      return node.name;
    case 'call':
      return `${node.name}(${node.args.map(print).join(',')})`;
    case 'invoke':
      return `${wrap(node.callee, power(node.callee) !== ATOMIC)}(${node.args.map(print).join(',')})`;
    case 'unary':
      return node.op + wrap(node.operand, power(node.operand) < power(node));
    case 'postfix':
      return wrap(node.operand, power(node.operand) < power(node)) + node.op;
    case 'binary': {
      const p = BINARY_POWER[node.op];
      return `${wrap(node.left, power(node.left) < p)}${node.op}${wrap(node.right, power(node.right) <= p)}`;
    }
  }
}

/** Prints an AST back to canonical formula text (without the leading '='), adding only required parens. */
export function printFormula(node: Node): string {
  return print(node);
}
