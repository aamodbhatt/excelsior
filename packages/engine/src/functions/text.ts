import { deref, isGridLike } from '../compile/ops';
import { parseNumericText, toNumber, toText } from '../core/coerce';
import { CellError, Errors } from '../core/errors';
import type { Scalar } from '../core/values';
import { formatNumber } from '../format/numberFormat';
import { define, eachValue, scalarFn } from './helpers';
import type { FunctionSpec } from './types';

const cat = 'text' as const;

function str(x: Scalar): string | CellError {
  return toText(x);
}

function count(x: Scalar | undefined, fallback: number): number | CellError {
  if (x === undefined || x === null) return fallback;
  const n = toNumber(x);
  if (n instanceof CellError) return n;
  return n < 0 ? Errors.value : Math.trunc(n);
}

export const textFunctions: FunctionSpec[] = [
  scalarFn({ name: 'LEN', min: 1, max: 1, sig: 'LEN(text)', desc: 'Number of characters', cat }, ([x]) => {
    const s = str(x);
    return s instanceof CellError ? s : s.length;
  }),
  scalarFn(
    { name: 'LEFT', min: 1, max: 2, sig: 'LEFT(text, [num_chars])', desc: 'Leftmost characters', cat },
    ([x, n]) => {
      const s = str(x);
      const k = count(n, 1);
      if (s instanceof CellError) return s;
      if (k instanceof CellError) return k;
      return s.slice(0, k);
    },
  ),
  scalarFn(
    { name: 'RIGHT', min: 1, max: 2, sig: 'RIGHT(text, [num_chars])', desc: 'Rightmost characters', cat },
    ([x, n]) => {
      const s = str(x);
      const k = count(n, 1);
      if (s instanceof CellError) return s;
      if (k instanceof CellError) return k;
      return k === 0 ? '' : s.slice(-k);
    },
  ),
  scalarFn(
    {
      name: 'MID',
      min: 3,
      max: 3,
      sig: 'MID(text, start_num, num_chars)',
      desc: 'Characters from the middle',
      cat,
    },
    ([x, a, n]) => {
      const s = str(x);
      const start = toNumber(a);
      const k = count(n, 0);
      if (s instanceof CellError) return s;
      if (start instanceof CellError) return start;
      if (k instanceof CellError) return k;
      if (start < 1) return Errors.value;
      return s.substr(Math.trunc(start) - 1, k);
    },
  ),
  scalarFn({ name: 'UPPER', min: 1, max: 1, sig: 'UPPER(text)', desc: 'Upper case', cat }, ([x]) => {
    const s = str(x);
    return s instanceof CellError ? s : s.toUpperCase();
  }),
  scalarFn({ name: 'LOWER', min: 1, max: 1, sig: 'LOWER(text)', desc: 'Lower case', cat }, ([x]) => {
    const s = str(x);
    return s instanceof CellError ? s : s.toLowerCase();
  }),
  scalarFn({ name: 'TRIM', min: 1, max: 1, sig: 'TRIM(text)', desc: 'Removes extra spaces', cat }, ([x]) => {
    const s = str(x);
    return s instanceof CellError ? s : s.trim().replace(/ +/g, ' ');
  }),
  scalarFn(
    { name: 'REPT', min: 2, max: 2, sig: 'REPT(text, number_times)', desc: 'Repeats text', cat },
    ([x, n]) => {
      const s = str(x);
      const k = count(n, 0);
      if (s instanceof CellError) return s;
      if (k instanceof CellError) return k;
      return s.length * k > 32767 ? Errors.value : s.repeat(k);
    },
  ),
  scalarFn(
    { name: 'EXACT', min: 2, max: 2, sig: 'EXACT(text1, text2)', desc: 'Case-sensitive equality', cat },
    ([a, b]) => {
      const x = str(a);
      const y = str(b);
      if (x instanceof CellError) return x;
      if (y instanceof CellError) return y;
      return x === y;
    },
  ),
  scalarFn(
    {
      name: 'SUBSTITUTE',
      min: 3,
      max: 4,
      sig: 'SUBSTITUTE(text, old_text, new_text, [instance_num])',
      desc: 'Replaces text',
      cat,
    },
    ([t, o, n, inst]) => {
      const s = str(t);
      const from = str(o);
      const to = str(n);
      if (s instanceof CellError) return s;
      if (from instanceof CellError) return from;
      if (to instanceof CellError) return to;
      if (from === '') return s;
      if (inst === undefined || inst === null) return s.split(from).join(to);
      const k = toNumber(inst);
      if (k instanceof CellError) return k;
      let idx = -1;
      for (let i = 0; i < k; i++) {
        idx = s.indexOf(from, idx + 1);
        if (idx < 0) return s;
      }
      return s.slice(0, idx) + to + s.slice(idx + from.length);
    },
  ),
  ...(['FIND', 'SEARCH'] as const).map((name) =>
    scalarFn(
      {
        name,
        min: 2,
        max: 3,
        sig: `${name}(find_text, within_text, [start_num])`,
        desc: name === 'FIND' ? 'Case-sensitive position' : 'Case-insensitive position',
        cat,
      },
      ([f, w, s]) => {
        const needle = str(f);
        const hay = str(w);
        const start = s === undefined || s === null ? 1 : toNumber(s);
        if (needle instanceof CellError) return needle;
        if (hay instanceof CellError) return hay;
        if (start instanceof CellError) return start;
        const i =
          name === 'FIND'
            ? hay.indexOf(needle, start - 1)
            : hay.toLowerCase().indexOf(needle.toLowerCase(), start - 1);
        return i < 0 ? Errors.value : i + 1;
      },
    ),
  ),
  scalarFn(
    { name: 'VALUE', min: 1, max: 1, sig: 'VALUE(text)', desc: 'Converts text to a number', cat },
    ([x]) => {
      if (typeof x === 'number') return x;
      const s = str(x);
      if (s instanceof CellError) return s;
      const n = parseNumericText(s);
      return n === null ? Errors.value : n;
    },
  ),
  scalarFn(
    { name: 'TEXT', min: 2, max: 2, sig: 'TEXT(value, format_text)', desc: 'Formats a number as text', cat },
    ([v, f]) => {
      const fmt = str(f);
      if (fmt instanceof CellError) return fmt;
      if (typeof v !== 'number') return str(v);
      return formatNumber(v, fmt).text;
    },
  ),
  scalarFn(
    { name: 'CHAR', min: 1, max: 1, sig: 'CHAR(number)', desc: 'Character for a code', cat },
    ([x]) => {
      const n = toNumber(x);
      if (n instanceof CellError) return n;
      return n >= 1 && n <= 255 ? String.fromCharCode(Math.trunc(n)) : Errors.value;
    },
  ),
  scalarFn(
    { name: 'CODE', min: 1, max: 1, sig: 'CODE(text)', desc: 'Code of the first character', cat },
    ([x]) => {
      const s = str(x);
      if (s instanceof CellError) return s;
      return s.length ? s.charCodeAt(0) : Errors.value;
    },
  ),
  define({ name: 'CONCAT', min: 1, max: 255, sig: 'CONCAT(text1, ...)', desc: 'Joins text', cat }, (args) => {
    let out = '';
    let err: CellError | null = null;
    eachValue(args, (v) => {
      if (err) return;
      const s = str(v);
      if (s instanceof CellError) err = s;
      else out += s;
    });
    return err ?? out;
  }),
  scalarFn(
    { name: 'CONCATENATE', min: 1, max: 255, sig: 'CONCATENATE(text1, ...)', desc: 'Joins text', cat },
    (xs) => {
      let out = '';
      for (const x of xs) {
        const s = str(x);
        if (s instanceof CellError) return s;
        out += s;
      }
      return out;
    },
  ),
  define(
    {
      name: 'TEXTJOIN',
      min: 3,
      max: 255,
      sig: 'TEXTJOIN(delimiter, ignore_empty, text1, ...)',
      desc: 'Joins text with a delimiter',
      cat,
    },
    (args) => {
      const d = deref(args[0]);
      const delim = isGridLike(d) ? Errors.value : str(d);
      if (delim instanceof CellError) return delim;
      const ignore = deref(args[1]) === true;
      const parts: string[] = [];
      let err: CellError | null = null;
      eachValue(
        args.slice(2),
        (v) => {
          if (err) return;
          const s = str(v);
          if (s instanceof CellError) err = s;
          else if (!(ignore && s === '')) parts.push(s);
        },
        true,
      );
      return err ?? parts.join(delim);
    },
  ),
];
