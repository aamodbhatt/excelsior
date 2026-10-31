import type { ErrorCode } from '../core/errors';
import {
  type ArrayLiteralItem,
  BINARY_POWER,
  type BinaryOp,
  type Node,
  PERCENT_POWER,
  PREFIX_POWER,
  SPILL_POWER,
} from './ast';
import { FormulaSyntaxError, type Token, tokenize } from './lexer';

const BINARY_OPS = new Set(Object.keys(BINARY_POWER));

/** Strips the prefixes Excel writes into files for functions newer than 2007. */
export function normalizeFunctionName(name: string): string {
  return name
    .toUpperCase()
    .replace(/^_XLFN\./, '')
    .replace(/^_XLWS\./, '');
}

/**
 * A Pratt parser for Excel formulas. Precedence (low to high): comparison, &, + -, * /, ^, unary -, %,
 * the range operator ':' and the spill operator '#'. All binary operators are left-associative, like Excel.
 */
class Parser {
  private i = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.expr(0);
    const t = this.peek();
    if (t.t !== 'eof') throw new FormulaSyntaxError(`Unexpected '${this.describe(t)}'`, t.pos);
    return node;
  }

  private peek(): Token {
    return this.tokens[this.i];
  }

  private next(): Token {
    return this.tokens[this.i++];
  }

  private isOp(op: string): boolean {
    const t = this.peek();
    return t.t === 'op' && t.op === op;
  }

  private expectOp(op: string): void {
    const t = this.next();
    if (t.t !== 'op' || t.op !== op) throw new FormulaSyntaxError(`Expected '${op}'`, t.pos);
  }

  private describe(t: Token): string {
    switch (t.t) {
      case 'op':
        return t.op;
      case 'ident':
        return t.name;
      case 'eof':
        return 'end of formula';
      default:
        return t.t;
    }
  }

  private expr(minPower: number): Node {
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      if (t.t !== 'op') break;
      if (t.op === '%' && PERCENT_POWER >= minPower) {
        this.next();
        left = { kind: 'postfix', op: '%', operand: left };
        continue;
      }
      if (t.op === '#' && SPILL_POWER >= minPower) {
        this.next();
        left = { kind: 'postfix', op: '#', operand: left };
        continue;
      }
      if (t.op === '(' && (left.kind === 'call' || left.kind === 'invoke' || left.kind === 'name')) {
        this.next();
        left = { kind: 'invoke', callee: left, args: this.args(')') };
        continue;
      }
      if (!BINARY_OPS.has(t.op)) break;
      const power = BINARY_POWER[t.op as BinaryOp];
      if (power < minPower) break;
      this.next();
      const right = this.expr(power + 1);
      left = { kind: 'binary', op: t.op as BinaryOp, left, right };
    }
    return left;
  }

  private prefix(): Node {
    const t = this.next();
    switch (t.t) {
      case 'number':
        return { kind: 'number', value: t.value };
      case 'string':
        return { kind: 'string', value: t.value };
      case 'error':
        return { kind: 'error', code: t.code };
      case 'ref':
        return t.ref;
      case 'ident': {
        const upper = t.name.toUpperCase();
        if (this.isOp('(')) {
          this.next();
          return { kind: 'call', name: normalizeFunctionName(t.name), args: this.args(')') };
        }
        if (upper === 'TRUE' || upper === 'FALSE') return { kind: 'boolean', value: upper === 'TRUE' };
        return { kind: 'name', name: t.name.replace(/^_xlpm\./i, '') };
      }
      case 'op':
        if (t.op === '-' || t.op === '+') {
          return { kind: 'unary', op: t.op, operand: this.expr(PREFIX_POWER) };
        }
        if (t.op === '@') return { kind: 'unary', op: '@', operand: this.expr(BINARY_POWER[':']) };
        if (t.op === '(') {
          const inner = this.expr(0);
          this.expectOp(')');
          return inner;
        }
        if (t.op === '{') return this.arrayLiteral();
        throw new FormulaSyntaxError(`Unexpected '${t.op}'`, t.pos);
      case 'eof':
        throw new FormulaSyntaxError('Unexpected end of formula', t.pos);
    }
  }

  /** Parses a comma-separated argument list; empty slots become `missing` nodes. */
  private args(close: string): Node[] {
    const args: Node[] = [];
    if (this.isOp(close)) {
      this.next();
      return args;
    }
    for (;;) {
      if (this.isOp(',') || this.isOp(close)) args.push({ kind: 'missing' });
      else args.push(this.expr(0));
      const t = this.next();
      if (t.t === 'op' && t.op === ',') continue;
      if (t.t === 'op' && t.op === close) return args;
      throw new FormulaSyntaxError(`Expected ',' or '${close}'`, t.pos);
    }
  }

  private arrayItem(): ArrayLiteralItem {
    let sign = 1;
    while (this.isOp('-') || this.isOp('+')) {
      if ((this.next() as { op: string }).op === '-') sign = -sign;
    }
    const t = this.next();
    if (t.t === 'number') return sign * t.value;
    if (sign === -1) throw new FormulaSyntaxError('Only numbers can be negated in an array constant', t.pos);
    if (t.t === 'string') return t.value;
    if (t.t === 'error') return { error: t.code as ErrorCode };
    if (t.t === 'ident' && /^(TRUE|FALSE)$/i.test(t.name)) return t.name.toUpperCase() === 'TRUE';
    throw new FormulaSyntaxError(
      'Array constants may only contain numbers, text, booleans and errors',
      t.pos,
    );
  }

  private arrayLiteral(): Node {
    const rows: ArrayLiteralItem[][] = [[]];
    for (;;) {
      rows[rows.length - 1].push(this.arrayItem());
      const t = this.next();
      if (t.t === 'op' && t.op === ',') continue;
      if (t.t === 'op' && t.op === ';') {
        rows.push([]);
        continue;
      }
      if (t.t === 'op' && t.op === '}') break;
      throw new FormulaSyntaxError("Expected ',', ';' or '}' in array constant", t.pos);
    }
    const width = rows[0].length;
    if (rows.some((r) => r.length !== width)) {
      throw new FormulaSyntaxError('Array constant rows must have the same length', 0);
    }
    return { kind: 'array', rows };
  }
}

/** Parses formula text. A leading '=' is optional. Throws FormulaSyntaxError with a position. */
export function parseFormula(text: string): Node {
  const body = text.startsWith('=') ? text.slice(1) : text;
  return new Parser(tokenize(body)).parse();
}
