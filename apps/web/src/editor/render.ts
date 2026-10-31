import {
  type ColorScaleRule,
  type ColorScaleStats,
  type EncodedScalar,
  type Rect,
  colToLetters,
  colorScale,
  formatA1,
  formatNumber,
  parseRect,
} from '@excelsior/engine';
import type { CellStyle, SheetDoc } from '@excelsior/doc';
import type { Axis } from './axis';
import type { Peer } from './collab';

export const HEADER_W = 58;
export const HEADER_H = 24;

export interface Selection {
  row: number;
  col: number;
  /** The selected range (always contains the active cell). */
  rect: Rect;
}

export interface Arrow {
  from: Rect;
  to: Rect;
  external: boolean;
}

export interface RenderInput {
  ctx: CanvasRenderingContext2D;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  rows: Axis;
  cols: Axis;
  sheet: SheetDoc;
  value: (row: number, col: number) => EncodedScalar | undefined;
  scale: (cfId: string) => ColorScaleStats | undefined;
  selection: Selection;
  peers: Peer[];
  arrows: Arrow[];
  refHighlights: { rect: Rect; color: string }[];
  dark: boolean;
}

export interface FormattedCell {
  text: string;
  align: 'left' | 'center' | 'right';
  color: string | null;
}

/** Display text and alignment for a computed value under a cell style. */
export function formatValue(v: EncodedScalar | undefined, style: CellStyle | undefined): FormattedCell {
  const align = style?.align;
  if (v === undefined || v === null) return { text: '', align: align ?? 'left', color: null };
  if (typeof v === 'number') {
    const f = formatNumber(v, style?.fmt ?? 'General');
    return { text: f.text, align: align ?? 'right', color: f.color };
  }
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE', align: align ?? 'center', color: null };
  if (typeof v === 'object') return { text: v.e, align: align ?? 'center', color: '#c5221f' };
  return { text: v, align: align ?? 'left', color: null };
}

const cfCache = new WeakMap<SheetDoc['condFormats'], { id: string; rect: Rect; scale: ColorScaleRule }[]>();

function condFormats(sheet: SheetDoc) {
  let list = cfCache.get(sheet.condFormats);
  if (!list) {
    list = sheet.condFormats.flatMap((cf) => {
      const rect = parseRect(cf.range);
      return rect ? [{ id: cf.id, rect, scale: cf.scale }] : [];
    });
    cfCache.set(sheet.condFormats, list);
  }
  return list;
}

/** Draws the visible part of the sheet. Everything is computed from scroll offsets; nothing is retained. */
export function renderGrid(p: RenderInput): void {
  const { ctx, width, height, rows, cols, sheet } = p;
  const theme = p.dark
    ? {
        bg: '#16181d',
        grid: '#2a2e36',
        header: '#1d2027',
        headerText: '#9aa0a6',
        text: '#e8eaed',
        headerSel: '#253048',
      }
    : {
        bg: '#ffffff',
        grid: '#e3e6ea',
        header: '#f6f7f9',
        headerText: '#5f6368',
        text: '#202124',
        headerSel: '#dde8fb',
      };
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);

  const r0 = rows.indexAt(p.scrollY);
  const c0 = cols.indexAt(p.scrollX);
  const visRows: number[] = [];
  const visCols: number[] = [];
  for (let r = r0; r < rows.count && rows.offsetOf(r) - p.scrollY < height - HEADER_H; r++) visRows.push(r);
  for (let c = c0; c < cols.count && cols.offsetOf(c) - p.scrollX < width - HEADER_W; c++) visCols.push(c);
  const x = (c: number) => HEADER_W + cols.offsetOf(c) - p.scrollX;
  const y = (r: number) => HEADER_H + rows.offsetOf(r) - p.scrollY;
  const cfs = condFormats(sheet);

  ctx.save();
  ctx.beginPath();
  ctx.rect(HEADER_W, HEADER_H, width - HEADER_W, height - HEADER_H);
  ctx.clip();
  ctx.textBaseline = 'middle';

  // Pass 1: fills (style fill or color scale).
  const cells: { r: number; c: number; v: EncodedScalar | undefined; style: CellStyle | undefined }[] = [];
  for (const r of visRows) {
    for (const c of visCols) {
      const style = sheet.cells[formatA1(r, c)]?.s;
      const v = p.value(r, c);
      cells.push({ r, c, v, style });
      let fill = style?.fill ?? null;
      if (typeof v === 'number') {
        for (const cf of cfs) {
          if (r >= cf.rect.r1 && r <= cf.rect.r2 && c >= cf.rect.c1 && c <= cf.rect.c2) {
            const stats = p.scale(cf.id);
            if (stats) fill = colorScale(cf.scale, stats, v);
          }
        }
      }
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fillRect(x(c), y(r), cols.size(c), rows.size(r));
      }
    }
  }

  // Pass 2: grid lines.
  ctx.strokeStyle = theme.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const r of visRows) {
    const yy = Math.round(y(r) + rows.size(r)) - 0.5;
    ctx.moveTo(HEADER_W, yy);
    ctx.lineTo(width, yy);
  }
  for (const c of visCols) {
    const xx = Math.round(x(c) + cols.size(c)) - 0.5;
    ctx.moveTo(xx, HEADER_H);
    ctx.lineTo(xx, height);
  }
  ctx.stroke();

  // Pass 3: text. Left-aligned text may overflow into empty neighbours, like in Excel.
  const isEmpty = (r: number, c: number) => {
    const v = p.value(r, c);
    return (v === undefined || v === null || v === '') && !sheet.cells[formatA1(r, c)]?.s?.fill;
  };
  for (const { r, c, v, style } of cells) {
    if (v === undefined || v === null || v === '') continue;
    const f = formatValue(v, style);
    if (!f.text) continue;
    const size = style?.size ?? 12;
    ctx.font = `${style?.italic ? 'italic ' : ''}${style?.bold ? '600 ' : ''}${size}px Inter, "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = style?.color ?? f.color ?? theme.text;
    const cx = x(c);
    const cy = y(r);
    let w = cols.size(c);
    if (f.align === 'left' && typeof v === 'string') {
      for (let k = c + 1; w < 900 && k < cols.count && isEmpty(r, k); k++) w += cols.size(k);
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(cx, cy, w, rows.size(r));
    ctx.clip();
    const pad = 4;
    const tx =
      f.align === 'left' ? cx + pad : f.align === 'right' ? cx + cols.size(c) - pad : cx + cols.size(c) / 2;
    ctx.textAlign = f.align;
    ctx.fillText(f.text, tx, cy + rows.size(r) / 2 + 0.5);
    ctx.restore();
  }

  // Formula reference highlights (while editing), peers, selection and trace arrows.
  const rectBox = (rect: Rect) => {
    const left = x(rect.c1);
    const top = y(rect.r1);
    return { left, top, w: x(rect.c2) + cols.size(rect.c2) - left, h: y(rect.r2) + rows.size(rect.r2) - top };
  };
  for (const h of p.refHighlights) {
    const b = rectBox(h.rect);
    ctx.fillStyle = `${h.color}22`;
    ctx.fillRect(b.left, b.top, b.w, b.h);
    ctx.strokeStyle = h.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(b.left + 1, b.top + 1, b.w - 2, b.h - 2);
  }
  ctx.font = '600 11px Inter, "Segoe UI", system-ui, sans-serif';
  for (const peer of p.peers) {
    if (!peer.presence || peer.presence.sheetId !== sheet.id) continue;
    const b = rectBox(peer.presence.selection);
    ctx.strokeStyle = peer.color;
    ctx.lineWidth = 2;
    ctx.strokeRect(b.left + 1, b.top + 1, b.w - 2, b.h - 2);
    const tw = ctx.measureText(peer.name).width + 8;
    ctx.fillStyle = peer.color;
    ctx.fillRect(b.left, b.top - 15, tw, 15);
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left';
    ctx.fillText(peer.name, b.left + 4, b.top - 7);
  }
  const sel = rectBox(p.selection.rect);
  ctx.fillStyle = 'rgba(31, 111, 235, 0.08)';
  ctx.fillRect(sel.left, sel.top, sel.w, sel.h);
  const act = rectBox({ r1: p.selection.row, c1: p.selection.col, r2: p.selection.row, c2: p.selection.col });
  ctx.strokeStyle = '#1f6feb';
  ctx.lineWidth = 2;
  ctx.strokeRect(sel.left + 1, sel.top + 1, sel.w - 2, sel.h - 2);
  ctx.strokeRect(act.left + 1, act.top + 1, act.w - 2, act.h - 2);
  ctx.fillStyle = '#1f6feb';
  ctx.fillRect(sel.left + sel.w - 4, sel.top + sel.h - 4, 7, 7);
  for (const a of p.arrows) {
    const from = rectBox(a.from);
    const to = rectBox(a.to);
    ctx.strokeStyle = a.external ? '#a14fd8' : '#1f6feb';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(from.left + 0.5, from.top + 0.5, from.w - 1, from.h - 1);
    const fx = from.left + Math.min(from.w, 40) / 2;
    const fy = from.top + Math.min(from.h, 22) / 2;
    const tx = to.left + to.w / 2;
    const ty = to.top + to.h / 2;
    ctx.beginPath();
    ctx.arc(fx, fy, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    const ang = Math.atan2(ty - fy, tx - fx);
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - 9 * Math.cos(ang - 0.4), ty - 9 * Math.sin(ang - 0.4));
    ctx.lineTo(tx - 9 * Math.cos(ang + 0.4), ty - 9 * Math.sin(ang + 0.4));
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();

  // Headers.
  ctx.font = '11px Inter, "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = theme.header;
  ctx.fillRect(0, 0, width, HEADER_H);
  ctx.fillRect(0, 0, HEADER_W, height);
  const s = p.selection.rect;
  for (const c of visCols) {
    if (c >= s.c1 && c <= s.c2) {
      ctx.fillStyle = theme.headerSel;
      ctx.fillRect(x(c), 0, cols.size(c), HEADER_H);
    }
    ctx.fillStyle = theme.headerText;
    if (cols.size(c) >= 26) ctx.fillText(colToLetters(c), x(c) + cols.size(c) / 2, HEADER_H / 2);
  }
  for (const r of visRows) {
    if (r >= s.r1 && r <= s.r2) {
      ctx.fillStyle = theme.headerSel;
      ctx.fillRect(0, y(r), HEADER_W, rows.size(r));
    }
    ctx.fillStyle = theme.headerText;
    ctx.fillText(String(r + 1), HEADER_W / 2, y(r) + rows.size(r) / 2);
  }
  ctx.strokeStyle = theme.grid;
  ctx.beginPath();
  ctx.moveTo(0, HEADER_H - 0.5);
  ctx.lineTo(width, HEADER_H - 0.5);
  ctx.moveTo(HEADER_W - 0.5, 0);
  ctx.lineTo(HEADER_W - 0.5, height);
  ctx.stroke();
}
