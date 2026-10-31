import { CellError, Errors } from './errors';
import type { Scalar } from './values';

const NUMERIC_TEXT = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*(%?)\s*$/;

/** Parses text the way Excel coerces it in arithmetic ("1.5" -> 1.5, "50%" -> 0.5). */
export function parseNumericText(text: string): number | null {
  const m = NUMERIC_TEXT.exec(text);
  if (!m) return null;
  const n = Number(text.trim().replace('%', ''));
  if (!Number.isFinite(n)) return null;
  return m[3] ? n / 100 : n;
}

export function toNumber(v: Scalar): number | CellError {
  if (typeof v === 'number') return v;
  if (v === null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof CellError) return v;
  const n = parseNumericText(v);
  return n === null ? Errors.value : n;
}

export function toText(v: Scalar): string | CellError {
  if (typeof v === 'string') return v;
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof CellError) return v;
  return numberToText(v);
}

export function toBoolean(v: Scalar): boolean | CellError {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null) return false;
  if (v instanceof CellError) return v;
  const u = v.toUpperCase();
  if (u === 'TRUE') return true;
  if (u === 'FALSE') return false;
  return Errors.value;
}

/** Formats a number like Excel's General format does in formulas (up to 15 significant digits). */
export function numberToText(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const p = Number.parseFloat(n.toPrecision(15));
  const s = String(p);
  return s.includes('e') ? s.replace('e', 'E') : s;
}

/** Excel's ordering across types: numbers < text < booleans. Blank compares as the other side's zero value. */
function typeRank(v: Exclude<Scalar, null | CellError>): number {
  return typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2;
}

/** Compares two non-error scalars; returns negative, zero or positive. Text compares case-insensitively. */
export function compareScalars(a: Exclude<Scalar, CellError>, b: Exclude<Scalar, CellError>): number {
  if (a === null && b === null) return 0;
  if (a === null) a = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (b === null) b = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === 'number') return a - (b as number);
  if (typeof a === 'string') {
    const x = a.toLowerCase();
    const y = (b as string).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return (a ? 1 : 0) - ((b as boolean) ? 1 : 0);
}

/** Equality used by lookups and comparisons: case-insensitive text, no cross-type equality. */
export function scalarsEqual(a: Scalar, b: Scalar): boolean {
  if (a instanceof CellError || b instanceof CellError) return false;
  return compareScalars(a, b) === 0;
}
