import type { Rect } from '../core/address';
import type { EncodedScalar } from '../core/encode';
import type { IterationState } from '../calc/workbook';
import type {
  CellEdit,
  EngineEnvelope,
  EngineMessage,
  EngineRequest,
  EngineSnapshot,
  RangePayload,
  RecalcStats,
  StructureOp,
  TraceResult,
} from './protocol';

/** Anything that can carry messages to an EngineHost: a Worker, a MessagePort, or a test loopback. */
export interface EngineTransport {
  send(envelope: EngineEnvelope): void;
  onMessage(listener: (msg: EngineMessage) => void): void;
}

export type PatchListener = (stats: RecalcStats | null, ranges: RangePayload[]) => void;

/** Promise-based client for the engine worker. Requests are answered in the order they were sent. */
export class EngineClient {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<PatchListener>();

  constructor(private readonly transport: EngineTransport) {
    transport.onMessage((msg) => {
      if (msg.kind === 'patch') {
        for (const l of this.listeners) l(msg.stats, msg.ranges);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
  }

  onPatch(listener: PatchListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private request<T>(request: EngineRequest): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.transport.send({ id, request });
    });
  }

  load(snapshot: EngineSnapshot): Promise<RecalcStats> {
    return this.request({ type: 'load', snapshot });
  }

  edit(
    edits: CellEdit[],
    structure?: StructureOp[],
    iterationState?: IterationState | null,
  ): Promise<RecalcStats> {
    return this.request({ type: 'edit', edits, structure, iterationState });
  }

  calculate(iterations?: number): Promise<RecalcStats> {
    return this.request({ type: 'calculate', iterations });
  }

  subscribe(subId: string, sheetId: string, rect: Rect): Promise<null> {
    return this.request({ type: 'subscribe', subId, sheetId, rect });
  }

  unsubscribe(subId: string): Promise<null> {
    return this.request({ type: 'unsubscribe', subId });
  }

  getRange(sheetId: string, rect: Rect): Promise<EncodedScalar[]> {
    return this.request({ type: 'getRange', sheetId, rect });
  }

  getIterationState(): Promise<IterationState> {
    return this.request({ type: 'getIterationState' });
  }

  trace(sheetId: string, row: number, col: number): Promise<TraceResult> {
    return this.request({ type: 'trace', sheetId, row, col });
  }
}
