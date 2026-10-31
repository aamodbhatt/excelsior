import type { Rect } from '../core/address';
import type { EncodedScalar } from '../core/encode';
import type { CalcSettings, CellInput, ChangedRegion, IterationState } from '../calc/workbook';

/** Everything needed to build an engine workbook from scratch. */
export interface EngineSnapshot {
  sheets: { id: string; name: string; cells: [row: number, col: number, input: CellInput][] }[];
  names: Record<string, string>;
  settings: Partial<CalcSettings>;
  iterationState?: IterationState | null;
}

export interface CellEdit {
  sheetId: string;
  row: number;
  col: number;
  input: CellInput;
}

export type StructureOp =
  | { op: 'addSheet'; id: string; name: string }
  | { op: 'renameSheet'; id: string; name: string }
  | { op: 'removeSheet'; id: string }
  | { op: 'defineName'; name: string; formula: string | null }
  | { op: 'settings'; patch: Partial<CalcSettings> };

export interface RecalcStats {
  evaluated: number;
  iterations: number;
  totalIterations: number;
  elapsedMs: number;
  circular: boolean;
}

export type EngineRequest =
  | { type: 'load'; snapshot: EngineSnapshot }
  | { type: 'edit'; edits: CellEdit[]; structure?: StructureOp[]; iterationState?: IterationState | null }
  | { type: 'calculate'; iterations?: number }
  | { type: 'subscribe'; subId: string; sheetId: string; rect: Rect }
  | { type: 'unsubscribe'; subId: string }
  | { type: 'getRange'; sheetId: string; rect: Rect }
  | { type: 'getIterationState' }
  | { type: 'trace'; sheetId: string; row: number; col: number };

export interface TraceResult {
  precedents: ChangedRegion[];
  dependents: { sheetId: string; row: number; col: number }[];
}

/** Values of one subscribed rectangle, row-major. */
export interface RangePayload {
  subId: string;
  sheetId: string;
  rect: Rect;
  values: EncodedScalar[];
}

export type EngineMessage =
  | { kind: 'response'; id: number; ok: true; result: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }
  | { kind: 'patch'; stats: RecalcStats | null; ranges: RangePayload[] };

export interface EngineEnvelope {
  id: number;
  request: EngineRequest;
}
