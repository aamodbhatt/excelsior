import type { EncodedScalar } from '@excelsior/engine';
import type { ChartDoc } from '@excelsior/doc';
import { useEffect, useRef } from 'react';

export interface SeriesData {
  name: string;
  color: string;
  x: EncodedScalar[] | null;
  y: EncodedScalar[];
}

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-12; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

/** A small canvas line or scatter chart; non-numeric points (blank history slots) are skipped. */
export function Chart({ chart, series }: { chart: ChartDoc; series: SeriesData[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    const W = chart.width;
    const H = chart.height;
    c.width = W * dpr;
    c.height = H * dpr;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const pts = series.map((s) => {
      const out: [number, number][] = [];
      s.y.forEach((y, i) => {
        const x = s.x ? s.x[i] : i;
        if (typeof y === 'number' && typeof x === 'number') out.push([x, y]);
      });
      return out;
    });
    const all = pts.flat();
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const [x0, x1] = chart.xRange ?? [Math.min(...xs, 0), Math.max(...xs, 1)];
    const [y0, y1] = chart.yRange ?? [Math.min(...ys, 0), Math.max(...ys, 1)];
    const L = 44;
    const R = 12;
    const T = 30;
    const B = 26;
    const px = (x: number) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R);
    const py = (y: number) => H - B - ((y - y0) / (y1 - y0 || 1)) * (H - T - B);
    ctx.font = '600 12px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#202124';
    ctx.textAlign = 'left';
    ctx.fillText(chart.title, L, 18);
    ctx.font = '10px Inter, "Segoe UI", system-ui, sans-serif';
    ctx.strokeStyle = '#eceef1';
    ctx.fillStyle = '#80868b';
    ctx.lineWidth = 1;
    for (const t of niceTicks(y0, y1, 4)) {
      ctx.beginPath();
      ctx.moveTo(L, py(t));
      ctx.lineTo(W - R, py(t));
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(String(t), L - 6, py(t) + 3);
    }
    for (const t of niceTicks(x0, x1, 5)) {
      ctx.textAlign = 'center';
      ctx.fillText(String(t), px(t), H - B + 14);
    }
    series.forEach((s, i) => {
      const p = pts[i];
      ctx.strokeStyle = s.color;
      ctx.fillStyle = s.color;
      if (chart.type === 'line') {
        ctx.lineWidth = 2;
        ctx.beginPath();
        p.forEach(([x, y], k) =>
          k ? ctx.lineTo(px(x), py(Math.min(y1, Math.max(y0, y)))) : ctx.moveTo(px(x), py(y)),
        );
        ctx.stroke();
      } else {
        for (const [x, y] of p) {
          ctx.beginPath();
          ctx.arc(px(x), py(y), 2.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.textAlign = 'right';
      ctx.font = '600 10px Inter, "Segoe UI", system-ui, sans-serif';
      ctx.fillText(s.name, W - R, 18 + i * 12);
    });
  }, [chart, series]);

  return (
    <canvas
      ref={canvas}
      className="chart"
      style={{ width: chart.width, height: chart.height }}
      data-testid={`chart-${chart.id}`}
    />
  );
}
