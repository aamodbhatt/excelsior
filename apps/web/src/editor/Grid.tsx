import { MAX_COLS, MAX_ROWS, type Rect } from '@excelsior/engine';
import type { SheetDoc } from '@excelsior/doc';
import { type ReactNode, useEffect, useMemo, useReducer, useRef } from 'react';
import { Axis } from './axis';
import type { Peer } from './collab';
import { type Arrow, HEADER_H, HEADER_W, type Selection, renderGrid } from './render';
import { type EngineView, windowValue } from './session';

const DEFAULT_ROW = 22;
const DEFAULT_COL = 92;
/** Browsers cap element sizes (~17M px in Firefox); beyond this the scrollbar maps proportionally. */
const MAX_SCROLL_PX = 15_000_000;

export interface GridProps {
  sheet: SheetDoc;
  engine: EngineView;
  selection: Selection;
  peers: Peer[];
  arrows: Arrow[];
  refHighlights: { rect: Rect; color: string }[];
  onSelect: (sel: Selection) => void;
  onEdit: () => void;
  /** Dragging the fill handle ended over this rectangle (it contains the original selection). */
  onFill: (source: Rect, target: Rect) => void;
  /** Rendered over the canvas in content coordinates (charts, the cell editor). */
  overlay: (
    place: (row: number, col: number) => { left: number; top: number; width: number; height: number },
  ) => ReactNode;
  scrollTo: { row: number; col: number; nonce: number } | null;
}

export function useAxes(sheet: SheetDoc): { rows: Axis; cols: Axis } {
  return useMemo(
    () => ({
      rows: new Axis(
        MAX_ROWS,
        DEFAULT_ROW,
        new Map(Object.entries(sheet.rowHeights).map(([k, v]) => [Number(k), v])),
      ),
      cols: new Axis(
        MAX_COLS,
        DEFAULT_COL,
        new Map(Object.entries(sheet.colWidths).map(([k, v]) => [Number(k), v])),
      ),
    }),
    [sheet.rowHeights, sheet.colWidths],
  );
}

/** A canvas-rendered, virtualized grid. Only visible cells are drawn and only they are fetched. */
export function Grid(props: GridProps) {
  const { sheet, engine } = props;
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const axesNow = useAxes(sheet);
  const { rows, cols } = axesNow;
  const latest = useRef(props);
  latest.current = props;
  // Callbacks scheduled from outside React (engine patches, rAF) must read the current sheet's axes.
  const axes = useRef(axesNow);
  axes.current = axesNow;
  const frame = useRef(0);
  const size = useRef({ w: 0, h: 0 });
  const drag = useRef<{ row: number; col: number } | null>(null);
  const fill = useRef<Rect | null>(null);

  const scrollScale = () => {
    const viewH = size.current.h - HEADER_H;
    const total = axes.current.rows.total;
    if (total <= MAX_SCROLL_PX) return { spacerH: total, toContent: (s: number) => s };
    const ratio = (total - viewH) / (MAX_SCROLL_PX - viewH);
    return { spacerH: MAX_SCROLL_PX, toContent: (s: number) => s * ratio };
  };

  const scrollPos = () => {
    const el = scroller.current!;
    return { x: el.scrollLeft, y: scrollScale().toContent(el.scrollTop) };
  };

  const draw = () => {
    frame.current = 0;
    const c = canvas.current;
    if (!c) return;
    const p = latest.current;
    const { rows, cols } = axes.current;
    const dpr = window.devicePixelRatio || 1;
    const { w, h } = size.current;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const pos = scrollPos();
    const view = p.engine.windows.get('view');
    renderGrid({
      ctx,
      width: w,
      height: h,
      scrollX: pos.x,
      scrollY: pos.y,
      rows,
      cols,
      sheet: p.sheet,
      value: (r, cc) => (view?.sheetId === p.sheet.id ? windowValue(view, r, cc) : undefined),
      scale: (id) => p.engine.scaleStats.get(`${p.sheet.id}:${id}`),
      selection: p.selection,
      peers: p.peers,
      arrows: p.arrows,
      refHighlights: p.refHighlights,
      dark: false,
    });
    // Ask the worker for the visible block, snapped so small scrolls reuse the same subscription.
    const r0 = rows.indexAt(pos.y);
    const c0 = cols.indexAt(pos.x);
    const r1 = Math.floor(r0 / 50) * 50;
    const c1 = Math.floor(c0 / 10) * 10;
    const r2 = Math.min(MAX_ROWS - 1, Math.ceil((rows.indexAt(pos.y + h) + 1) / 50) * 50 + 49);
    const c2 = Math.min(MAX_COLS - 1, cols.indexAt(pos.x + w) + 12);
    p.engine.setViewport(p.sheet.id, { r1, c1, r2, c2 });
    overlayTick.current?.();
  };
  const overlayTick = useRef<(() => void) | null>(null);

  const schedule = () => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  };

  useEffect(() => engine.subscribe(schedule), [engine]);
  useEffect(schedule);

  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      size.current = { w: el.clientWidth, h: el.clientHeight };
      const c = canvas.current!;
      c.width = Math.round(el.clientWidth * dpr);
      c.height = Math.round(el.clientHeight * dpr);
      c.style.width = `${el.clientWidth}px`;
      c.style.height = `${el.clientHeight}px`;
      schedule();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const t = props.scrollTo;
    const el = scroller.current;
    if (!t || !el) return;
    const top = rows.offsetOf(t.row);
    const left = cols.offsetOf(t.col);
    const { h, w } = size.current;
    const pos = scrollPos();
    if (top < pos.y || top > pos.y + h - HEADER_H - 40)
      el.scrollTop = Math.max(0, top - 60) / (scrollScale().toContent(1) || 1);
    if (left < pos.x || left > pos.x + w - HEADER_W - 100) el.scrollLeft = Math.max(0, left - 60);
  }, [props.scrollTo?.nonce]);

  const cellAt = (e: React.MouseEvent) => {
    const rect = scroller.current!.getBoundingClientRect();
    const pos = scrollPos();
    const px = e.clientX - rect.left - HEADER_W + pos.x;
    const py = e.clientY - rect.top - HEADER_H + pos.y;
    return {
      row: Math.max(0, rows.indexAt(Math.max(0, py))),
      col: Math.max(0, cols.indexAt(Math.max(0, px))),
      inHeaderRow: e.clientY - rect.top < HEADER_H,
      inHeaderCol: e.clientX - rect.left < HEADER_W,
    };
  };

  const rectOf = (a: { row: number; col: number }, b: { row: number; col: number }): Rect => ({
    r1: Math.min(a.row, b.row),
    c1: Math.min(a.col, b.col),
    r2: Math.max(a.row, b.row),
    c2: Math.max(a.col, b.col),
  });

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const hit = cellAt(e);
    const p = latest.current;
    if (hit.inHeaderRow && !hit.inHeaderCol) {
      p.onSelect({ row: 0, col: hit.col, rect: { r1: 0, c1: hit.col, r2: MAX_ROWS - 1, c2: hit.col } });
      return;
    }
    if (hit.inHeaderCol && !hit.inHeaderRow) {
      p.onSelect({ row: hit.row, col: 0, rect: { r1: hit.row, c1: 0, r2: hit.row, c2: MAX_COLS - 1 } });
      return;
    }
    if (e.shiftKey) {
      p.onSelect({ ...p.selection, rect: rectOf(p.selection, hit) });
      return;
    }
    // The fill handle is the small square at the bottom-right corner of the selection.
    const sel = p.selection.rect;
    const corner = place(sel.r2, sel.c2);
    const box = scroller.current!.getBoundingClientRect();
    const hx = e.clientX - box.left - (corner.left + corner.width);
    const hy = e.clientY - box.top - (corner.top + corner.height);
    if (Math.abs(hx) <= 5 && Math.abs(hy) <= 5) {
      fill.current = sel;
      return;
    }
    drag.current = hit;
    p.onSelect({ row: hit.row, col: hit.col, rect: rectOf(hit, hit) });
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (fill.current && e.buttons & 1) {
      const hit = cellAt(e);
      const s = fill.current;
      // Fill extends along one axis only, whichever the pointer moved further along.
      const down = hit.row > s.r2 ? hit.row - s.r2 : hit.row < s.r1 ? hit.row - s.r1 : 0;
      const right = hit.col > s.c2 ? hit.col - s.c2 : hit.col < s.c1 ? hit.col - s.c1 : 0;
      const rect =
        Math.abs(down) >= Math.abs(right)
          ? { ...s, r1: Math.min(s.r1, hit.row), r2: Math.max(s.r2, hit.row) }
          : { ...s, c1: Math.min(s.c1, hit.col), c2: Math.max(s.c2, hit.col) };
      latest.current.onSelect({ ...latest.current.selection, rect });
      return;
    }
    if (!drag.current || !(e.buttons & 1)) return;
    const hit = cellAt(e);
    const p = latest.current;
    p.onSelect({ row: drag.current.row, col: drag.current.col, rect: rectOf(drag.current, hit) });
  };

  const place = (row: number, col: number) => {
    const { rows, cols } = axes.current;
    const pos = scroller.current ? scrollPos() : { x: 0, y: 0 };
    return {
      left: HEADER_W + cols.offsetOf(col) - pos.x,
      top: HEADER_H + rows.offsetOf(row) - pos.y,
      width: cols.size(col),
      height: rows.size(row),
    };
  };

  return (
    <div className="grid-wrap" ref={wrap}>
      <canvas ref={canvas} className="grid-canvas" />
      <div
        className="grid-scroller"
        ref={scroller}
        data-testid="grid"
        onScroll={schedule}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={() => {
          drag.current = null;
          if (fill.current) {
            const target = latest.current.selection.rect;
            const source = fill.current;
            fill.current = null;
            if (
              target.r1 !== source.r1 ||
              target.r2 !== source.r2 ||
              target.c1 !== source.c1 ||
              target.c2 !== source.c2
            )
              latest.current.onFill(source, target);
          }
        }}
        onDoubleClick={() => latest.current.onEdit()}
      >
        <div
          style={{
            width: cols.offsetOf(Math.min(MAX_COLS, 400)) + HEADER_W,
            height: scrollScale().spacerH + HEADER_H,
          }}
        />
      </div>
      <OverlayLayer register={(fn) => (overlayTick.current = fn)}>{() => props.overlay(place)}</OverlayLayer>
    </div>
  );
}

/** Re-renders positioned overlays (charts, the in-cell editor) on every canvas frame. */
function OverlayLayer({
  register,
  children,
}: {
  register: (fn: () => void) => void;
  children: () => ReactNode;
}) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => register(force), []);
  return <div className="grid-overlay">{children()}</div>;
}
