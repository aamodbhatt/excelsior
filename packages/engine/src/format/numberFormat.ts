/**
 * A compact implementation of Excel number format codes: up to four `;`-separated sections
 * (positive; negative; zero; text), digit placeholders (0 # ?), thousands separators, percent,
 * scientific notation, quoted literals and `[Color]` tags. Formats are compiled once and cached.
 */

export interface FormattedNumber {
  text: string;
  color: string | null;
}

interface Section {
  prefix: string;
  suffix: string;
  intDigits: number;
  decimals: number;
  optionalDecimals: number;
  thousands: boolean;
  percent: number;
  scientific: boolean;
  expDigits: number;
  color: string | null;
  literalOnly: boolean;
}

const COLORS: Record<string, string> = {
  red: '#d93025',
  blue: '#1a73e8',
  green: '#188038',
  black: '#202124',
  white: '#ffffff',
  magenta: '#c2185b',
  cyan: '#0097a7',
  yellow: '#f9ab00',
};

function splitSections(code: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') quoted = !quoted;
    if (ch === '\\' && i + 1 < code.length) {
      cur += ch + code[++i];
      continue;
    }
    if (ch === ';' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function compileSection(src: string): Section {
  const s: Section = {
    prefix: '',
    suffix: '',
    intDigits: 0,
    decimals: 0,
    optionalDecimals: 0,
    thousands: false,
    percent: 0,
    scientific: false,
    expDigits: 0,
    color: null,
    literalOnly: true,
  };
  let seenDigit = false;
  let inDecimals = false;
  let afterDigits = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '[') {
      const end = src.indexOf(']', i);
      const tag = src.slice(i + 1, end).toLowerCase();
      if (COLORS[tag]) s.color = COLORS[tag];
      i = end;
      continue;
    }
    if (ch === '"') {
      const end = src.indexOf('"', i + 1);
      const lit = src.slice(i + 1, end < 0 ? src.length : end);
      if (afterDigits) s.suffix += lit;
      else s.prefix += lit;
      i = end < 0 ? src.length : end;
      continue;
    }
    if (ch === '\\') {
      const lit = src[++i] ?? '';
      if (afterDigits) s.suffix += lit;
      else s.prefix += lit;
      continue;
    }
    if (ch === '_' || ch === '*') {
      i++;
      continue;
    }
    if (ch === '0' || ch === '#' || ch === '?') {
      s.literalOnly = false;
      seenDigit = true;
      if (s.scientific) s.expDigits++;
      else if (inDecimals) {
        if (ch === '0') s.decimals++;
        else s.optionalDecimals++;
      } else if (ch === '0') s.intDigits++;
      continue;
    }
    if (ch === '.' && !s.scientific) {
      inDecimals = true;
      s.literalOnly = false;
      continue;
    }
    if (ch === ',' && seenDigit && !inDecimals) {
      s.thousands = true;
      continue;
    }
    if (ch === '%') {
      s.percent++;
      if (seenDigit) {
        afterDigits = true;
        s.suffix += '%';
      } else s.prefix += '%';
      continue;
    }
    if ((ch === 'E' || ch === 'e') && seenDigit && (src[i + 1] === '+' || src[i + 1] === '-')) {
      s.scientific = true;
      i++;
      continue;
    }
    if (seenDigit) {
      afterDigits = true;
      s.suffix += ch;
    } else s.prefix += ch;
  }
  return s;
}

function groupThousands(int: string): string {
  return int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function applySection(value: number, s: Section): string {
  if (s.literalOnly) return s.prefix + s.suffix;
  let x = Math.abs(value) * 100 ** s.percent;
  if (s.scientific) {
    const digits = s.decimals + s.optionalDecimals;
    const [mant, exp] = x.toExponential(digits).split('e');
    const e = Number(exp);
    const expText = String(Math.abs(e)).padStart(Math.max(s.expDigits, 1), '0');
    return `${s.prefix}${mant}E${e < 0 ? '-' : '+'}${expText}${s.suffix}`;
  }
  const digits = s.decimals + s.optionalDecimals;
  x = Number(x.toFixed(digits));
  let [int, frac = ''] = x.toFixed(digits).split('.');
  if (s.optionalDecimals) frac = frac.replace(/0+$/, '').padEnd(s.decimals, '0');
  if (int === '0' && s.intDigits === 0) int = '';
  if (int.length < s.intDigits) int = int.padStart(s.intDigits, '0');
  if (s.thousands) int = groupThousands(int);
  return `${s.prefix}${int}${frac ? `.${frac}` : ''}${s.suffix}`;
}

/** Excel's General format: up to 10 significant digits, scientific for very large or small magnitudes. */
export function formatGeneral(value: number): string {
  if (value === 0) return '0';
  const abs = Math.abs(value);
  const s = Number(value.toPrecision(10)).toString();
  if (abs < 1e11 && abs >= 1e-9 && !s.includes('e')) return s;
  const [mantissa, exp] = value.toExponential(5).split('e');
  const e = Number(exp);
  return `${mantissa.replace(/\.?0+$/, '')}E${e < 0 ? '-' : '+'}${String(Math.abs(e)).padStart(2, '0')}`;
}

type Compiled = (value: number) => FormattedNumber;

const cache = new Map<string, Compiled>();

function compile(code: string): Compiled {
  if (code === '' || code.toLowerCase() === 'general') {
    return (v) => ({ text: formatGeneral(v), color: null });
  }
  const sections = splitSections(code).map(compileSection);
  const [pos, neg, zero] = sections;
  return (v) => {
    if (v < 0 && neg) return { text: applySection(v, neg), color: neg.color };
    if (v === 0 && zero) return { text: applySection(v, zero), color: zero.color };
    const text = applySection(v, pos);
    return { text: v < 0 && !neg && !pos.literalOnly ? `-${text}` : text, color: pos.color };
  };
}

/** Formats a number with an Excel format code ("0.00", "#,##0", "0%", "0.00E+00", ";;;" ...). */
export function formatNumber(value: number, code: string): FormattedNumber {
  let f = cache.get(code);
  if (!f) {
    f = compile(code);
    cache.set(code, f);
  }
  return f(value);
}
