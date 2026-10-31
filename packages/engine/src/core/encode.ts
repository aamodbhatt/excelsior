import { CellError, type ErrorCode } from './errors';
import type { Scalar } from './values';

/** JSON- and structured-clone-safe form of a scalar (errors lose their class across boundaries). */
export type EncodedScalar = number | string | boolean | null | { e: ErrorCode };

export function encodeScalar(v: Scalar): EncodedScalar {
  return v instanceof CellError ? { e: v.code } : v;
}

export function decodeScalar(v: EncodedScalar): Scalar {
  return v !== null && typeof v === 'object' ? new CellError(v.e) : v;
}
