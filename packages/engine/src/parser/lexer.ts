import { MAX_COLS, MAX_ROWS, lettersToCol } from '../core/address';
import { ERROR_CODES, type ErrorCode } from '../core/errors';
import type { RefNode, RefPoint } from './ast';

export type Token =
  | { t: 'number'; value: number; pos: number; end: number }
  | { t: 'string'; value: string; pos: number; end: number }
  | { t: 'error'; code: ErrorCode; pos: number; end: number }
  | { t: 'ref'; ref: RefNode; pos: number; end: number }
  | { t: 'ident'; name: string; pos: number; end: number }
  | { t: 'op'; op: string; pos: number; end: number }
  | { t: 'eof'; pos: number; end: number };

export class FormulaSyntaxError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
    this.name = 'FormulaSyntaxError';
  }
}

const CELL = String.raw`(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})`;
const AREA_RE = new RegExp(`^${CELL}(?::${CELL})?(?![A-Za-z0-9_.(!])`);
const COLS_RE = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})(?![A-Za-z0-9_.(])/;
const ROWS_RE = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})(?![0-9.A-Za-z])/;
const NUMBER_RE = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/;
const IDENT_RE = /^[A-Za-z_\\][A-Za-z0-9_.]*/;
const SHEET_RE = /^([A-Za-z_][A-Za-z0-9_.]*)!/;
const OPS2 = ['<>', '<=', '>='];
const OPS1 = '+-*/^&=<>%:,;(){}@#';

function point(rowText: string, rowAbs: string, colText: string, colAbs: string): RefPoint | null {
  const col = lettersToCol(colText);
  const row = Number(rowText) - 1;
  if (col < 0 || row < 0 || row >= MAX_ROWS) return null;
  return { row, col, rowAbs: rowAbs === '$', colAbs: colAbs === '$' };
}

/** Tries to read a reference at the start of `s`; returns the node and consumed length. */
function readRef(s: string, sheet: string | null): { ref: RefNode; len: number } | null {
  let m = AREA_RE.exec(s);
  if (m) {
    const a = point(m[4], m[3], m[2], m[1]);
    if (a) {
      if (m[5] === undefined)
        return { ref: { kind: 'ref', sheet, type: 'cell', start: a, end: a }, len: m[0].length };
      const b = point(m[8], m[7], m[6], m[5]);
      if (b) return { ref: { kind: 'ref', sheet, type: 'area', start: a, end: b }, len: m[0].length };
    }
  }
  m = COLS_RE.exec(s);
  if (m) {
    const c1 = lettersToCol(m[2]);
    const c2 = lettersToCol(m[4]);
    if (c1 >= 0 && c2 >= 0) {
      return {
        ref: {
          kind: 'ref',
          sheet,
          type: 'cols',
          start: { row: 0, col: c1, rowAbs: true, colAbs: m[1] === '$' },
          end: { row: MAX_ROWS - 1, col: c2, rowAbs: true, colAbs: m[3] === '$' },
        },
        len: m[0].length,
      };
    }
  }
  m = ROWS_RE.exec(s);
  if (m) {
    const r1 = Number(m[2]) - 1;
    const r2 = Number(m[4]) - 1;
    if (r1 >= 0 && r2 >= 0 && r1 < MAX_ROWS && r2 < MAX_ROWS) {
      return {
        ref: {
          kind: 'ref',
          sheet,
          type: 'rows',
          start: { row: r1, col: 0, rowAbs: m[1] === '$', colAbs: true },
          end: { row: r2, col: MAX_COLS - 1, rowAbs: m[3] === '$', colAbs: true },
        },
        len: m[0].length,
      };
    }
  }
  return null;
}

/** Splits formula text (without the leading '=') into tokens. */
export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    const rest = src.slice(i);
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      for (;;) {
        if (j >= src.length) throw new FormulaSyntaxError('Unterminated string literal', i);
        if (src[j] === '"') {
          if (src[j + 1] === '"') {
            value += '"';
            j += 2;
            continue;
          }
          break;
        }
        value += src[j++];
      }
      out.push({ t: 'string', value, pos: i, end: j + 1 });
      i = j + 1;
      continue;
    }
    if (ch === "'") {
      let j = i + 1;
      let name = '';
      for (;;) {
        if (j >= src.length) throw new FormulaSyntaxError('Unterminated sheet name', i);
        if (src[j] === "'") {
          if (src[j + 1] === "'") {
            name += "'";
            j += 2;
            continue;
          }
          break;
        }
        name += src[j++];
      }
      if (src[j + 1] !== '!') throw new FormulaSyntaxError("Expected '!' after quoted sheet name", j + 1);
      const r = readRef(src.slice(j + 2), name);
      if (!r) throw new FormulaSyntaxError('Expected a reference after sheet name', j + 2);
      out.push({ t: 'ref', ref: r.ref, pos: i, end: j + 2 + r.len });
      i = j + 2 + r.len;
      continue;
    }
    if (ch === '#') {
      const code = ERROR_CODES.find((c) => rest.toUpperCase().startsWith(c));
      if (code) {
        out.push({ t: 'error', code, pos: i, end: i + code.length });
        i += code.length;
        continue;
      }
      out.push({ t: 'op', op: '#', pos: i, end: i + 1 });
      i++;
      continue;
    }
    if ((ch >= '0' && ch <= '9') || ch === '.' || ch === '$') {
      const rows = ch !== '.' ? readRef(rest, null) : null;
      if (rows && rows.ref.type === 'rows') {
        out.push({ t: 'ref', ref: rows.ref, pos: i, end: i + rows.len });
        i += rows.len;
        continue;
      }
      if (ch === '$') {
        if (rows) {
          out.push({ t: 'ref', ref: rows.ref, pos: i, end: i + rows.len });
          i += rows.len;
          continue;
        }
        throw new FormulaSyntaxError('Invalid reference', i);
      }
      const m = NUMBER_RE.exec(rest);
      if (!m) throw new FormulaSyntaxError('Invalid number', i);
      out.push({ t: 'number', value: Number(m[0]), pos: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_\\]/.test(ch)) {
      const sheet = SHEET_RE.exec(rest);
      if (sheet) {
        const r = readRef(rest.slice(sheet[0].length), sheet[1]);
        if (!r) throw new FormulaSyntaxError('Expected a reference after sheet name', i + sheet[0].length);
        out.push({ t: 'ref', ref: r.ref, pos: i, end: i + sheet[0].length + r.len });
        i += sheet[0].length + r.len;
        continue;
      }
      const r = readRef(rest, null);
      if (r) {
        out.push({ t: 'ref', ref: r.ref, pos: i, end: i + r.len });
        i += r.len;
        continue;
      }
      const m = IDENT_RE.exec(rest)!;
      out.push({ t: 'ident', name: m[0], pos: i, end: i + m[0].length });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      out.push({ t: 'op', op: two, pos: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (OPS1.includes(ch)) {
      out.push({ t: 'op', op: ch, pos: i, end: i + 1 });
      i++;
      continue;
    }
    throw new FormulaSyntaxError(`Unexpected character '${ch}'`, i);
  }
  out.push({ t: 'eof', pos: src.length, end: src.length });
  return out;
}
