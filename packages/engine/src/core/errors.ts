/** Excel-compatible error codes, plus #CIRC! for circular references when iteration is disabled. */
export type ErrorCode =
  | '#NULL!'
  | '#DIV/0!'
  | '#VALUE!'
  | '#REF!'
  | '#NAME?'
  | '#NUM!'
  | '#N/A'
  | '#SPILL!'
  | '#CALC!'
  | '#CIRC!';

export const ERROR_CODES: readonly ErrorCode[] = [
  '#NULL!',
  '#DIV/0!',
  '#VALUE!',
  '#REF!',
  '#NAME?',
  '#NUM!',
  '#N/A',
  '#SPILL!',
  '#CALC!',
  '#CIRC!',
];

/** ERROR.TYPE numbers as defined by Excel (#CIRC! is ours and gets a private number). */
const ERROR_TYPE_NUMBER: Record<ErrorCode, number> = {
  '#NULL!': 1,
  '#DIV/0!': 2,
  '#VALUE!': 3,
  '#REF!': 4,
  '#NAME?': 5,
  '#NUM!': 6,
  '#N/A': 7,
  '#SPILL!': 9,
  '#CALC!': 14,
  '#CIRC!': 99,
};

/** An error value. Compare errors by `code`, never by identity. */
export class CellError {
  constructor(
    readonly code: ErrorCode,
    readonly detail?: string,
  ) {}

  get typeNumber(): number {
    return ERROR_TYPE_NUMBER[this.code];
  }

  toString(): string {
    return this.code;
  }
}

export const Errors = {
  null: new CellError('#NULL!'),
  div0: new CellError('#DIV/0!'),
  value: new CellError('#VALUE!'),
  ref: new CellError('#REF!'),
  name: new CellError('#NAME?'),
  num: new CellError('#NUM!'),
  na: new CellError('#N/A'),
  spill: new CellError('#SPILL!'),
  calc: new CellError('#CALC!'),
  circ: new CellError('#CIRC!'),
} as const;

export function errorFromCode(code: string): CellError | null {
  const upper = code.toUpperCase();
  return (ERROR_CODES as readonly string[]).includes(upper) ? new CellError(upper as ErrorCode) : null;
}
