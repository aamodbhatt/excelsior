import {
  type ColorScaleStats,
  type CellEdit,
  type EncodedScalar,
  EngineClient,
  type EngineEnvelope,
  type EngineMessage,
  type Rect,
  type RecalcStats,
  type StructureOp,
  computeScaleStats,
  parseA1,
  parseRect,
} from '@excelsior/engine';
import { type Op, type WorkbookDoc, engineInput, toEngineSnapshot } from '@excelsior/doc';

/** A cached rectangle of computed values for one sheet. */
export interface ValueWindow {
  sheetId: string;
  rect: Rect;
  values: EncodedScalar[];
}

export function windowValue(w: ValueWindow | undefined, row: number, col: number): EncodedScalar | undefined {
  if (!w || row < w.rect.r1 || row > w.rect.r2 || col < w.rect.c1 || col > w.rect.c2) return undefined;
  return w.values[(row - w.rect.r1) * (w.rect.c2 - w.rect.c1 + 1) + (col - w.rect.c1)];
}

/** Resolves "Name" or "Sheet!A1" to a sheet id and cell, using the document's defined names. */
export function resolveRef(doc: WorkbookDoc, ref: string): { sheetId: string; rect: Rect } | null {
  let text = ref;
  const named = Object.entries(doc.names).find(([k]) => k.toUpperCase() === ref.toUpperCase());
  if (named) text = named[1].replace(/^=/, '').replace(/#$/, '');
  const bang = text.lastIndexOf('!');
  const sheetName = bang >= 0 ? text.slice(0, bang).replace(/^'|'$/g, '') : null;
  const sheet = sheetName
    ? doc.sheets.find((s) => s.name.toUpperCase() === sheetName.toUpperCase())
    : doc.sheets[0];
  const rect = parseRect(text.slice(bang + 1).replace(/\$/g, ''));
  return sheet && rect ? { sheetId: sheet.id, rect } : null;
}

function createWorkerClient(): { client: EngineClient; worker: Worker } {
  const worker = new Worker(new URL('../engine.worker.ts', import.meta.url), { type: 'module' });
  const client = new EngineClient({
    send: (env: EngineEnvelope) => worker.postMessage(env),
    onMessage: (l) => {
      worker.onmessage = (e: MessageEvent<EngineMessage>) => l(e.data);
    },
  });
  return { client, worker };
}

/** Converts document ops into engine edits, taking inputs from the current visible document. */
export function engineChanges(
  doc: WorkbookDoc,
  ops: Op[],
): { edits: CellEdit[]; structure: StructureOp[]; iterationState?: WorkbookDoc['iterationState'] } {
  const edits: CellEdit[] = [];
  const structure: StructureOp[] = [];
  let iterationState: WorkbookDoc['iterationState'] | undefined;
  for (const op of ops) {
    if (op.t === 'cells') {
      const sheet = doc.sheets.find((s) => s.id === op.sheet);
      if (!sheet) continue;
      for (const addr of Object.keys(op.cells)) {
        const a = parseA1(addr)!;
        edits.push({ sheetId: op.sheet, row: a.row, col: a.col, input: engineInput(sheet.cells[addr]?.v) });
      }
    } else if (op.t === 'addSheet') structure.push({ op: 'addSheet', id: op.sheet, name: op.name });
    else if (op.t === 'renameSheet') structure.push({ op: 'renameSheet', id: op.sheet, name: op.name });
    else if (op.t === 'calc') structure.push({ op: 'settings', patch: op.calc });
    else if (op.t === 'iterationState') iterationState = op.state;
  }
  return { edits, structure, iterationState };
}

/**
 * Bridges a document to a calculation worker and keeps caches of values the UI needs: the visible
 * viewport, conditional-format ranges (for color-scale stats), chart series and watched cells.
 */
export class EngineView {
  readonly client: EngineClient;
  private readonly worker: Worker;
  windows = new Map<string, ValueWindow>();
  scaleStats = new Map<string, ColorScaleStats>();
  stats: RecalcStats | null = null;
  private listeners = new Set<() => void>();
  private doc: WorkbookDoc | null = null;
  private subs = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor() {
    const { client, worker } = createWorkerClient();
    this.client = client;
    this.worker = worker;
    client.onPatch((stats, ranges) => {
      if (stats) this.stats = stats;
      for (const r of ranges)
        this.windows.set(r.subId, { sheetId: r.sheetId, rect: r.rect, values: r.values });
      this.refreshScaleStats();
      this.emit();
    });
  }

  dispose(): void {
    this.worker.terminate();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** Serializes engine requests so edits and loads apply in order. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  load(doc: WorkbookDoc): Promise<RecalcStats> {
    this.doc = doc;
    return this.enqueue(async () => {
      const stats = await this.client.load(toEngineSnapshot(doc));
      this.stats = stats;
      await this.syncDerivedSubs();
      this.emit();
      return stats;
    });
  }

  apply(doc: WorkbookDoc, ops: Op[]): Promise<RecalcStats | null> {
    this.doc = doc;
    const { edits, structure, iterationState } = engineChanges(doc, ops);
    if (!edits.length && !structure.length && iterationState === undefined) {
      return this.enqueue(async () => {
        await this.syncDerivedSubs();
        this.emit();
        return null;
      });
    }
    return this.enqueue(async () => {
      const stats = await this.client.edit(edits, structure, iterationState ?? undefined);
      await this.syncDerivedSubs();
      return stats;
    });
  }

  calculate(iterations: number): Promise<RecalcStats> {
    return this.enqueue(() => this.client.calculate(iterations));
  }

  iterationState() {
    return this.enqueue(() => this.client.getIterationState());
  }

  trace(sheetId: string, row: number, col: number) {
    return this.enqueue(() => this.client.trace(sheetId, row, col));
  }

  setViewport(sheetId: string, rect: Rect): void {
    void this.enqueue(() => this.setSub('view', sheetId, rect));
  }

  private async setSub(id: string, sheetId: string, rect: Rect): Promise<void> {
    const key = `${sheetId}:${rect.r1}:${rect.c1}:${rect.r2}:${rect.c2}`;
    if (this.subs.get(id) === key) return;
    this.subs.set(id, key);
    await this.client.subscribe(id, sheetId, rect);
  }

  /** Keeps subscriptions for every conditional format, chart series and watch in sync with the doc. */
  private async syncDerivedSubs(): Promise<void> {
    const doc = this.doc;
    if (!doc) return;
    const wanted = new Map<string, { sheetId: string; rect: Rect }>();
    for (const s of doc.sheets) {
      for (const cf of s.condFormats) {
        const rect = parseRect(cf.range);
        if (rect) wanted.set(`cf:${s.id}:${cf.id}`, { sheetId: s.id, rect });
      }
      for (const ch of s.charts) {
        ch.series.forEach((ser, i) => {
          for (const [k, ref] of [
            ['x', ser.x],
            ['y', ser.y],
          ] as const) {
            const r = ref ? resolveRef(doc, ref) : null;
            if (r) wanted.set(`chart:${s.id}:${ch.id}:${i}:${k}`, r);
          }
        });
      }
    }
    for (const w of doc.watches) {
      const r = resolveRef(doc, w);
      if (r) wanted.set(`watch:${w}`, r);
    }
    for (const id of [...this.subs.keys()]) {
      if (id !== 'view' && !wanted.has(id)) {
        this.subs.delete(id);
        this.windows.delete(id);
        await this.client.unsubscribe(id);
      }
    }
    for (const [id, { sheetId, rect }] of wanted) await this.setSub(id, sheetId, rect);
  }

  private refreshScaleStats(): void {
    const doc = this.doc;
    if (!doc) return;
    for (const s of doc.sheets) {
      for (const cf of s.condFormats) {
        const w = this.windows.get(`cf:${s.id}:${cf.id}`);
        if (!w) continue;
        const nums = w.values.filter((v): v is number => typeof v === 'number');
        this.scaleStats.set(`${s.id}:${cf.id}`, computeScaleStats(cf.scale, nums));
      }
    }
  }
}

/** Loads a historical document into its own worker for read-only previews while scrubbing. */
export function previewEngine(): EngineView {
  return new EngineView();
}
