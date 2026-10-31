import type { CalcSettings, ColorScaleRule, IterationState } from '@excelsior/engine';

/** Visual style of a cell. All fields optional; absent means default. */
export interface CellStyle {
  /** Excel number format code, e.g. "0.00%" or ";;;". */
  fmt?: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  fill?: string;
  align?: 'left' | 'center' | 'right';
  size?: number;
}

/** A cell: its input (what the user typed, formulas start with "=") and style. */
export interface CellDoc {
  v?: string;
  s?: CellStyle;
}

export interface CondFormatDoc {
  id: string;
  /** A1 range on the same sheet, e.g. "G4:AP39". */
  range: string;
  scale: ColorScaleRule;
}

export interface ChartSeriesDoc {
  name: string;
  /** Range of x values (scatter) or category labels (line); optional for line charts. */
  x?: string;
  y: string;
  color: string;
}

export interface ChartDoc {
  id: string;
  type: 'line' | 'scatter';
  title: string;
  series: ChartSeriesDoc[];
  /** Top-left cell the chart floats over, plus its pixel size. */
  anchor: { row: number; col: number };
  width: number;
  height: number;
  xRange?: [number, number];
  yRange?: [number, number];
}

export interface SheetDoc {
  id: string;
  name: string;
  /** Keyed by A1 address. */
  cells: Record<string, CellDoc>;
  colWidths: Record<string, number>;
  rowHeights: Record<string, number>;
  condFormats: CondFormatDoc[];
  charts: ChartDoc[];
}

/**
 * Buttons a workbook declares for its viewers. `append` appends the value of `source` to the input of
 * `target` (used for autoregressive generation); `pulse` sets `target` TRUE for one iteration then FALSE.
 */
export type ActionDoc =
  | { id: string; label: string; kind: 'append'; target: string; source: string }
  | { id: string; label: string; kind: 'pulse'; target: string };

export interface WorkbookDoc {
  schema: 1;
  sheets: SheetDoc[];
  /** Defined names: name -> formula text (with leading "="). */
  names: Record<string, string>;
  calc: CalcSettings;
  /** Values of the integrator cells of circular chains; see the engine's iteration semantics. */
  iterationState: IterationState | null;
  /** Names or references shown in the watch bar (like Excel's Watch Window). */
  watches: string[];
  actions: ActionDoc[];
}

export function emptySheet(id: string, name: string): SheetDoc {
  return { id, name, cells: {}, colWidths: {}, rowHeights: {}, condFormats: [], charts: [] };
}

export function emptyWorkbook(): WorkbookDoc {
  return {
    schema: 1,
    sheets: [emptySheet('s1', 'Sheet1')],
    names: {},
    calc: { iterative: false, maxIterations: 100, maxChange: 0.001, seed: null },
    iterationState: null,
    watches: [],
    actions: [],
  };
}
