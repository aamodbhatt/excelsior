/** Grid limits match Excel so that workbooks round-trip without truncation. */
export const MAX_ROWS = 1_048_576;
export const MAX_COLS = 16_384;

/** A rectangular, inclusive cell region on one sheet (0-based coordinates). */
export interface Rect {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

/** Packs a cell coordinate into one integer; MAX_ROWS * MAX_COLS < 2^35 stays exact in a double. */
export function cellKey(row: number, col: number): number {
  return row * MAX_COLS + col;
}

export function keyRow(key: number): number {
  return Math.floor(key / MAX_COLS);
}

export function keyCol(key: number): number {
  return key % MAX_COLS;
}

export function colToLetters(col: number): string {
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Returns -1 when the letters are not a valid column. */
export function lettersToCol(letters: string): number {
  let n = 0;
  for (let i = 0; i < letters.length; i++) {
    const code = letters.charCodeAt(i) & ~32; // upper-case ASCII
    if (code < 65 || code > 90) return -1;
    n = n * 26 + (code - 64);
  }
  const col = n - 1;
  return col >= 0 && col < MAX_COLS ? col : -1;
}

export function formatA1(row: number, col: number): string {
  return colToLetters(col) + (row + 1);
}

export function formatRect(rect: Rect): string {
  const a = formatA1(rect.r1, rect.c1);
  return rect.r1 === rect.r2 && rect.c1 === rect.c2 ? a : `${a}:${formatA1(rect.r2, rect.c2)}`;
}

const A1_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

/** Parses a plain A1 address (dollar signs allowed). Returns null when invalid or out of bounds. */
export function parseA1(text: string): { row: number; col: number } | null {
  const m = A1_RE.exec(text.trim());
  if (!m) return null;
  const col = lettersToCol(m[1]);
  const row = Number(m[2]) - 1;
  if (col < 0 || row < 0 || row >= MAX_ROWS) return null;
  return { row, col };
}

/** Parses "A1" or "A1:B5" into a normalized rect. */
export function parseRect(text: string): Rect | null {
  const parts = text.split(':');
  if (parts.length > 2) return null;
  const a = parseA1(parts[0]);
  const b = parts.length === 2 ? parseA1(parts[1]) : a;
  if (!a || !b) return null;
  return {
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.col, b.col),
  };
}

export function rectContains(rect: Rect, row: number, col: number): boolean {
  return row >= rect.r1 && row <= rect.r2 && col >= rect.c1 && col <= rect.c2;
}

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return a.r1 <= b.r2 && b.r1 <= a.r2 && a.c1 <= b.c2 && b.c1 <= a.c2;
}

export function rectArea(rect: Rect): number {
  return (rect.r2 - rect.r1 + 1) * (rect.c2 - rect.c1 + 1);
}
