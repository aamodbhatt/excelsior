import { describe, expect, it } from 'vitest';
import { EngineClient, type EngineEnvelope, EngineHost, type EngineMessage, type RangePayload } from '../src';

/** Wires a client to a host through structuredClone, exactly what postMessage does between threads. */
function connect(): { client: EngineClient; patches: RangePayload[][] } {
  let deliver: (m: EngineMessage) => void = () => {};
  const host = new EngineHost((msg) => queueMicrotask(() => deliver(structuredClone(msg))));
  const client = new EngineClient({
    send: (env: EngineEnvelope) => queueMicrotask(() => host.handle(structuredClone(env))),
    onMessage: (l) => {
      deliver = l;
    },
  });
  const patches: RangePayload[][] = [];
  client.onPatch((_s, ranges) => patches.push(ranges));
  return { client, patches };
}

describe('worker protocol', () => {
  it('loads a snapshot, edits, and pushes patches for subscribed ranges', async () => {
    const { client, patches } = connect();
    await client.load({
      sheets: [
        {
          id: 's1',
          name: 'Sheet1',
          cells: [
            [0, 0, 2],
            [0, 1, '=A1*21'],
          ],
        },
      ],
      names: {},
      settings: {},
    });
    await client.subscribe('view', 's1', { r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(patches.at(-1)![0].values).toEqual([2, 42, null, null]);
    const stats = await client.edit([{ sheetId: 's1', row: 0, col: 0, input: 3 }]);
    expect(stats.evaluated).toBe(1);
    expect(patches.at(-1)![0].values).toEqual([3, 63, null, null]);
    await client.edit([{ sheetId: 's1', row: 5, col: 5, input: 1 }]);
    expect(patches.at(-1)!.length).toBe(0);
  });

  it('serializes errors and reports request failures', async () => {
    const { client } = connect();
    await client.load({
      sheets: [{ id: 's1', name: 'S', cells: [[0, 0, '=1/0']] }],
      names: {},
      settings: {},
    });
    expect(await client.getRange('s1', { r1: 0, c1: 0, r2: 0, c2: 0 })).toEqual([{ e: '#DIV/0!' }]);
    await expect(client.edit([{ sheetId: 'nope', row: 0, col: 0, input: 1 }])).rejects.toThrow(
      /Unknown sheet/,
    );
  });

  it('runs forced iterations, traces, and round-trips iteration state', async () => {
    const { client } = connect();
    await client.load({
      sheets: [
        {
          id: 's1',
          name: 'S',
          cells: [
            [0, 0, '=A1+1'],
            [0, 1, '=A1*2'],
          ],
        },
      ],
      names: {},
      settings: { iterative: true, maxIterations: 1, maxChange: 0 },
    });
    const stats = await client.calculate(4);
    expect(stats.iterations).toBe(4);
    const state = await client.getIterationState();
    expect(state.cells[0].values).toEqual([5]);
    const trace = await client.trace('s1', 0, 1);
    expect(trace.precedents).toEqual([{ sheetId: 's1', rect: { r1: 0, c1: 0, r2: 0, c2: 0 } }]);
    expect(trace.dependents).toEqual([]);
  });
});
