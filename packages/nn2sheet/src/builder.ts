import { type ColorScaleRule, formatA1, numberToText } from '@excelsior/engine';
import { type CellStyle, type ChartDoc, type SheetDoc, emptySheet } from '@excelsior/doc';

/** A placed block: its top-left cell and size, with helpers to reference it from formulas. */
export class Block {
  constructor(
    readonly sheet: string,
    readonly row: number,
    readonly col: number,
    readonly rows: number,
    readonly cols: number,
  ) {}

  /** Absolute reference to the whole block, e.g. Net!$A$5:$B$204. */
  ref(qualified = true): string {
    const a = `$${formatA1(this.row, this.col).replace(/(\d+)$/, '$$$1')}`;
    const b = `$${formatA1(this.row + this.rows - 1, this.col + this.cols - 1).replace(/(\d+)$/, '$$$1')}`;
    return `${qualified ? `${this.sheet}!` : ''}${a}:${b}`;
  }

  /** Absolute reference to the anchor's spill, e.g. Net!$E$5#. */
  spill(qualified = true): string {
    return `${qualified ? `${this.sheet}!` : ''}$${formatA1(this.row, this.col).replace(/(\d+)$/, '$$$1')}#`;
  }

  /** Relative A1 address of one cell of the block. */
  cell(r: number, c: number): string {
    return formatA1(this.row + r, this.col + c);
  }

  range(): string {
    return `${formatA1(this.row, this.col)}:${formatA1(this.row + this.rows - 1, this.col + this.cols - 1)}`;
  }
}

/** Writes cells into a SheetDoc with a small, explicit API. */
export class SheetBuilder {
  readonly doc: SheetDoc;
  private cfId = 0;

  constructor(id: string, name: string) {
    this.doc = emptySheet(id, name);
  }

  get name(): string {
    return this.doc.name;
  }

  set(row: number, col: number, input: string | number | boolean, style?: CellStyle): void {
    const v =
      typeof input === 'number'
        ? numberToShortest(input)
        : typeof input === 'boolean'
          ? input
            ? 'TRUE'
            : 'FALSE'
          : input;
    this.doc.cells[formatA1(row, col)] = style ? { v, s: style } : { v };
  }

  style(row: number, col: number, style: CellStyle): void {
    const a = formatA1(row, col);
    this.doc.cells[a] = { ...this.doc.cells[a], s: { ...this.doc.cells[a]?.s, ...style } };
  }

  label(row: number, col: number, text: string, style: CellStyle = { bold: true, color: '#5f6368' }): void {
    this.set(row, col, text.startsWith('=') ? `'${text}` : text, style);
  }

  /** Writes a numeric matrix as constants and returns its block. */
  matrix(row: number, col: number, data: number[][], style?: CellStyle): Block {
    data.forEach((r, i) => r.forEach((v, j) => this.set(row + i, col + j, v, style)));
    return new Block(this.name, row, col, data.length, data[0]?.length ?? 0);
  }

  /** Writes a spilling formula; `rows`/`cols` is its expected extent (used for layout and styling). */
  formula(row: number, col: number, text: string, rows: number, cols: number, style?: CellStyle): Block {
    this.set(row, col, text, style);
    if (style)
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) if (r || c) this.style(row + r, col + c, style);
    return new Block(this.name, row, col, rows, cols);
  }

  colWidth(col: number, width: number): void {
    this.doc.colWidths[String(col)] = width;
  }

  rowHeight(row: number, height: number): void {
    this.doc.rowHeights[String(row)] = height;
  }

  colorScale(range: string, scale: ColorScaleRule): void {
    this.doc.condFormats.push({ id: `cf${++this.cfId}`, range, scale });
  }

  chart(chart: ChartDoc): void {
    this.doc.charts.push(chart);
  }
}

/** Shortest decimal text that parses back to exactly the same double. */
export function numberToShortest(n: number): string {
  const s = String(n);
  return Number(s) === n ? s.toUpperCase() : numberToText(n);
}

export const DIVERGING: ColorScaleRule = {
  min: { type: 'min', color: '#d9485f' },
  mid: { type: 'num', value: 0, color: '#ffffff' },
  max: { type: 'max', color: '#3b6fd9' },
};
