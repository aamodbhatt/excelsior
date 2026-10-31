/** One stop of a color scale: an automatic min/max, a fixed number, or a percentile of the range. */
export interface ScaleStop {
  type: 'min' | 'max' | 'num' | 'percentile';
  value?: number;
  color: string;
}

/** An Excel-style 2- or 3-color scale conditional format. */
export interface ColorScaleRule {
  min: ScaleStop;
  mid?: ScaleStop;
  max: ScaleStop;
}

export interface ColorScaleStats {
  min: number;
  mid: number | null;
  max: number;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = ((sorted.length - 1) * Math.min(Math.max(p, 0), 100)) / 100;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function resolve(stop: ScaleStop, sorted: number[]): number {
  switch (stop.type) {
    case 'min':
      return sorted[0] ?? 0;
    case 'max':
      return sorted[sorted.length - 1] ?? 0;
    case 'num':
      return stop.value ?? 0;
    case 'percentile':
      return percentile(sorted, stop.value ?? 50);
  }
}

/** Resolves the numeric thresholds of a rule against the numbers currently in its range. */
export function computeScaleStats(rule: ColorScaleRule, numbers: number[]): ColorScaleStats {
  const sorted = [...numbers].sort((a, b) => a - b);
  return {
    min: resolve(rule.min, sorted),
    mid: rule.mid ? resolve(rule.mid, sorted) : null,
    max: resolve(rule.max, sorted),
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = Number.parseInt(h.length === 3 ? h.replace(/(.)/g, '$1$1') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  const c = x.map((v, i) => Math.round(v + (y[i] - v) * t));
  return `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** The fill color for a value, interpolated linearly between stops like Excel does. */
export function colorScale(rule: ColorScaleRule, stats: ColorScaleStats, value: number): string {
  const clamp = (t: number) => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 0);
  if (rule.mid && stats.mid !== null) {
    if (value <= stats.mid) {
      const span = stats.mid - stats.min;
      return mix(rule.min.color, rule.mid.color, clamp(span === 0 ? 1 : (value - stats.min) / span));
    }
    const span = stats.max - stats.mid;
    return mix(rule.mid.color, rule.max.color, clamp(span === 0 ? 0 : (value - stats.mid) / span));
  }
  const span = stats.max - stats.min;
  return mix(rule.min.color, rule.max.color, clamp(span === 0 ? 0.5 : (value - stats.min) / span));
}
