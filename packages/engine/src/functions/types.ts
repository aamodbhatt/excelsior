import type { EvalContext } from '../compile/context';
import type { Value } from '../core/values';

/** A built-in function. Arguments arrive evaluated; references stay lazy (RangeRef) until read. */
export interface FunctionSpec {
  readonly name: string;
  readonly minArgs: number;
  readonly maxArgs: number;
  /** Re-evaluated on every recalculation (RAND, NOW, ...). */
  readonly volatile?: boolean;
  /** Human-readable signature for autocomplete and signature help, e.g. "MMULT(array1, array2)". */
  readonly signature: string;
  readonly description: string;
  readonly category: FunctionCategory;
  call(args: Value[], ctx: EvalContext): Value;
}

export type FunctionCategory =
  | 'math'
  | 'logical'
  | 'text'
  | 'lookup'
  | 'statistical'
  | 'array'
  | 'info'
  | 'lambda';

/** Metadata exported to the UI (no implementation). */
export interface FunctionInfo {
  name: string;
  signature: string;
  description: string;
  category: FunctionCategory;
}
