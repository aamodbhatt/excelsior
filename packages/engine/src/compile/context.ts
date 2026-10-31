import type { SheetReader, Value } from '../core/values';

/** Lexical environment frame for LET bindings and LAMBDA parameters. */
export interface Env {
  readonly vals: Value[];
  readonly parent: Env | null;
}

/** Services the evaluator needs from the workbook. Kept narrow so functions stay testable. */
export interface EvalHost {
  sheetByName(name: string): SheetReader | null;
  /** Evaluates a workbook-level defined name, or returns null when it does not exist. */
  evaluateName(name: string, ctx: EvalContext): Value | null;
  /** A uniform [0, 1) generator; deterministic per cell when the workbook has a seed. */
  random(ctx: EvalContext, stream: number): () => number;
}

/** Where an expression is being evaluated: the anchor cell plus the lexical environment. */
export interface EvalContext {
  readonly host: EvalHost;
  readonly sheet: SheetReader;
  readonly row: number;
  readonly col: number;
  readonly env: Env | null;
}

export type Thunk = (ctx: EvalContext) => Value;

export function withEnv(ctx: EvalContext, env: Env): EvalContext {
  return { host: ctx.host, sheet: ctx.sheet, row: ctx.row, col: ctx.col, env };
}
