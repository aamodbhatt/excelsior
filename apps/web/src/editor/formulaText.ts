import { type FunctionInfo, type Rect, type Token, listFunctions, tokenize } from '@excelsior/engine';

export const REF_COLORS = ['#1f6feb', '#e4572e', '#17a589', '#a14fd8', '#f1a208', '#d6336c'];
export const FUNCTIONS: FunctionInfo[] = listFunctions();

export interface Span {
  text: string;
  cls: string;
  color?: string;
}

/** Splits formula text into highlighted spans; references get a color shared with the grid outline. */
export function highlight(text: string): {
  spans: Span[];
  refs: { sheet: string | null; rect: Rect; color: string }[];
} {
  if (!text.startsWith('=')) return { spans: [{ text, cls: 'tok-plain' }], refs: [] };
  let tokens: Token[];
  try {
    tokens = tokenize(text.slice(1));
  } catch {
    return { spans: [{ text, cls: 'tok-plain' }], refs: [] };
  }
  const spans: Span[] = [{ text: '=', cls: 'tok-op' }];
  const refs: { sheet: string | null; rect: Rect; color: string }[] = [];
  let pos = 0;
  for (const t of tokens) {
    if (t.t === 'eof') break;
    if (t.pos > pos) spans.push({ text: text.slice(1 + pos, 1 + t.pos), cls: 'tok-plain' });
    const raw = text.slice(1 + t.pos, 1 + t.end);
    if (t.t === 'ref') {
      const color = REF_COLORS[refs.length % REF_COLORS.length];
      refs.push({
        sheet: t.ref.sheet,
        rect: {
          r1: Math.min(t.ref.start.row, t.ref.end.row),
          c1: Math.min(t.ref.start.col, t.ref.end.col),
          r2: Math.max(t.ref.start.row, t.ref.end.row),
          c2: Math.max(t.ref.start.col, t.ref.end.col),
        },
        color,
      });
      spans.push({ text: raw, cls: 'tok-ref', color });
    } else {
      const cls = { number: 'tok-num', string: 'tok-str', error: 'tok-err', ident: 'tok-fn', op: 'tok-op' }[
        t.t
      ];
      spans.push({ text: raw, cls });
    }
    pos = t.end;
  }
  if (pos < text.length - 1) spans.push({ text: text.slice(1 + pos), cls: 'tok-plain' });
  return { spans, refs };
}

/** The identifier being typed right before the caret, if it could be a function or name. */
export function completionPrefix(text: string, caret: number): string | null {
  if (!text.startsWith('=')) return null;
  const m = /[A-Za-z_][A-Za-z0-9_.]*$/.exec(text.slice(0, caret));
  if (!m) return null;
  const before = text.slice(0, caret - m[0].length);
  return /[=(,+\-*/^&<>:\s]$/.test(before) ? m[0] : null;
}

export function completions(
  prefix: string,
  names: string[],
): { name: string; detail: string; isFunction: boolean }[] {
  const p = prefix.toUpperCase();
  const fns = FUNCTIONS.filter((f) => f.name.startsWith(p)).map((f) => ({
    name: f.name,
    detail: f.description,
    isFunction: true,
  }));
  const ns = names
    .filter((n) => n.toUpperCase().startsWith(p))
    .map((n) => ({ name: n, detail: 'defined name', isFunction: false }));
  return [...ns, ...fns].slice(0, 8);
}

/** The innermost function call enclosing the caret and which argument the caret is in. */
export function signatureAt(text: string, caret: number): { fn: FunctionInfo; arg: number } | null {
  if (!text.startsWith('=')) return null;
  const stack: { name: string; arg: number }[] = [];
  let inString = false;
  let ident = '';
  for (let i = 1; i < caret; i++) {
    const ch = text[i];
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (/[A-Za-z0-9_.]/.test(ch)) {
      ident += ch;
      continue;
    }
    if (ch === '(') stack.push({ name: ident.toUpperCase(), arg: 0 });
    else if (ch === ')') stack.pop();
    else if (ch === ',' && stack.length) stack[stack.length - 1].arg++;
    ident = '';
  }
  for (let i = stack.length - 1; i >= 0; i--) {
    const fn = FUNCTIONS.find((f) => f.name === stack[i].name);
    if (fn) return { fn, arg: stack[i].arg };
  }
  return null;
}

/** Splits "NAME(a, b, [c])" into its parameter list for signature help. */
export function signatureParts(sig: string): { name: string; params: string[] } {
  const open = sig.indexOf('(');
  const inner = sig.slice(open + 1, sig.lastIndexOf(')'));
  return { name: sig.slice(0, open), params: inner ? inner.split(/,\s*/) : [] };
}
