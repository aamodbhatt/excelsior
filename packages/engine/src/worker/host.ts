import { type Rect, rectsIntersect } from '../core/address';
import { encodeScalar } from '../core/encode';
import { type RecalcReport, Workbook } from '../calc/workbook';
import type {
  EngineEnvelope,
  EngineMessage,
  EngineRequest,
  EngineSnapshot,
  RangePayload,
  RecalcStats,
  StructureOp,
  TraceResult,
} from './protocol';

interface Subscription {
  sheetId: string;
  rect: Rect;
}

/**
 * The worker side of the engine protocol. It owns one Workbook, applies requests in order, and pushes
 * fresh values for every subscribed rectangle that a recalculation touched.
 */
export class EngineHost {
  private workbook = new Workbook();
  private readonly subs = new Map<string, Subscription>();

  constructor(private readonly post: (msg: EngineMessage) => void) {}

  handle(envelope: EngineEnvelope): void {
    try {
      const result = this.dispatch(envelope.request);
      this.post({ kind: 'response', id: envelope.id, ok: true, result });
    } catch (e) {
      this.post({
        kind: 'response',
        id: envelope.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private dispatch(req: EngineRequest): unknown {
    switch (req.type) {
      case 'load':
        return this.load(req.snapshot);
      case 'edit': {
        if (req.structure) this.applyStructure(req.structure);
        for (const e of req.edits) this.workbook.setCell(e.sheetId, e.row, e.col, e.input);
        const report = req.iterationState
          ? this.workbook.setIterationState(req.iterationState)
          : this.workbook.recalc();
        return this.publish(report);
      }
      case 'calculate':
        return this.publish(this.workbook.recalc({ iterations: req.iterations }));
      case 'subscribe': {
        this.subs.set(req.subId, { sheetId: req.sheetId, rect: req.rect });
        this.post({ kind: 'patch', stats: null, ranges: [this.payload(req.subId, req.sheetId, req.rect)] });
        return null;
      }
      case 'unsubscribe':
        this.subs.delete(req.subId);
        return null;
      case 'getRange':
        return this.workbook.getRange(req.sheetId, req.rect).map(encodeScalar);
      case 'getIterationState':
        return this.workbook.getIterationState();
      case 'trace': {
        const result: TraceResult = {
          precedents: this.workbook.precedents(req.sheetId, req.row, req.col),
          dependents: this.workbook.dependents(req.sheetId, req.row, req.col),
        };
        return result;
      }
    }
  }

  private load(snapshot: EngineSnapshot): RecalcStats {
    this.workbook = new Workbook();
    this.workbook.setSettings(snapshot.settings);
    for (const s of snapshot.sheets) this.workbook.addSheet(s.id, s.name);
    for (const [name, formula] of Object.entries(snapshot.names)) this.workbook.defineName(name, formula);
    for (const s of snapshot.sheets)
      for (const [r, c, input] of s.cells) this.workbook.setCell(s.id, r, c, input);
    const report = snapshot.iterationState
      ? this.workbook.setIterationState(snapshot.iterationState)
      : this.workbook.recalc();
    const stats = this.stats(report);
    this.post({
      kind: 'patch',
      stats,
      ranges: [...this.subs].map(([id, s]) => this.payload(id, s.sheetId, s.rect)),
    });
    return stats;
  }

  private applyStructure(ops: StructureOp[]): void {
    for (const op of ops) {
      switch (op.op) {
        case 'addSheet':
          this.workbook.addSheet(op.id, op.name);
          break;
        case 'renameSheet':
          this.workbook.renameSheet(op.id, op.name);
          break;
        case 'removeSheet':
          this.workbook.removeSheet(op.id);
          break;
        case 'defineName':
          this.workbook.defineName(op.name, op.formula);
          break;
        case 'settings':
          this.workbook.setSettings(op.patch);
          break;
      }
    }
  }

  private stats(report: RecalcReport): RecalcStats {
    return {
      evaluated: report.evaluated,
      iterations: report.iterations,
      totalIterations: this.workbook.iterationCount,
      elapsedMs: report.elapsedMs,
      circular: report.circular,
    };
  }

  private publish(report: RecalcReport): RecalcStats {
    const stats = this.stats(report);
    const ranges: RangePayload[] = [];
    for (const [id, sub] of this.subs) {
      if (report.changed.some((c) => c.sheetId === sub.sheetId && rectsIntersect(c.rect, sub.rect))) {
        ranges.push(this.payload(id, sub.sheetId, sub.rect));
      }
    }
    this.post({ kind: 'patch', stats, ranges });
    return stats;
  }

  private payload(subId: string, sheetId: string, rect: Rect): RangePayload {
    return { subId, sheetId, rect, values: this.workbook.getRange(sheetId, rect).map(encodeScalar) };
  }
}
