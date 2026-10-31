import { type CellInput, type Scalar, Workbook, parseA1 } from '../src';

/** A one-sheet workbook for tests, addressed with A1 strings. */
export class TestBook {
  readonly wb = new Workbook();

  constructor(sheets: string[] = ['Sheet1']) {
    for (const s of sheets) this.wb.addSheet(s, s);
  }

  set(address: string, input: CellInput, sheet = 'Sheet1'): this {
    const a = parseA1(address);
    if (!a) throw new Error(`bad address ${address}`);
    this.wb.setCell(sheet, a.row, a.col, input);
    return this;
  }

  setMany(cells: Record<string, CellInput>, sheet = 'Sheet1'): this {
    for (const [a, v] of Object.entries(cells)) this.set(a, v, sheet);
    return this;
  }

  recalc(iterations?: number) {
    return this.wb.recalc(iterations === undefined ? {} : { iterations });
  }

  get(address: string, sheet = 'Sheet1'): Scalar {
    const a = parseA1(address)!;
    return this.wb.getValue(sheet, a.row, a.col);
  }

  /** Value as a plain JS value with errors as their code string. */
  plain(address: string, sheet = 'Sheet1'): number | string | boolean | null {
    const v = this.get(address, sheet);
    return v !== null && typeof v === 'object' ? v.code : v;
  }
}

/** Evaluates a single formula in a fresh workbook seeded with `cells`. */
export function evalFormula(
  formula: string,
  cells: Record<string, CellInput> = {},
): number | string | boolean | null {
  const b = new TestBook().setMany(cells).set('Z1000', formula);
  b.recalc();
  return b.plain('Z1000');
}
