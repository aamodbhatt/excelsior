/**
 * Evaluation schedule for a set of dirty formulas, computed with an iterative Tarjan SCC pass over the
 * dependency subgraph (edges point from a precedent to the formulas that read it).
 *
 * - SCCs come out in topological order, so every acyclic formula is evaluated after its precedents.
 * - Members of a cyclic SCC are ordered row-major (sheet order, then row, then column). Under iterative
 *   calculation each iteration evaluates the SCC once in that order, Gauss-Seidel style.
 * - A member is an *integrator* if it reads a value across a back edge in that order (including a
 *   self-reference): its new value depends on the previous iteration. Integrator values are the
 *   complete iteration state; every other member is a pure function of them within one iteration.
 */
export interface Schedule {
  /** Local node indices in evaluation order. */
  readonly order: Int32Array;
  /** SCC id per local node; SCC ids increase in evaluation order. */
  readonly scc: Int32Array;
  /** Whether each SCC (by id) contains a cycle. */
  readonly cyclic: boolean[];
  /** 1 for integrator nodes. */
  readonly integrator: Uint8Array;
}

export function buildSchedule(
  n: number,
  succStart: Int32Array,
  succ: Int32Array,
  rank: Float64Array,
): Schedule {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const stack = new Int32Array(n);
  const csNode = new Int32Array(n);
  const csEdge = new Int32Array(n);
  let sp = 0;
  let next = 0;
  const components: number[][] = [];

  for (let root = 0; root < n; root++) {
    if (index[root] !== -1) continue;
    let depth = 0;
    const enter = (v: number): void => {
      index[v] = low[v] = next++;
      stack[sp++] = v;
      onStack[v] = 1;
      csNode[depth] = v;
      csEdge[depth] = succStart[v];
      depth++;
    };
    enter(root);
    while (depth > 0) {
      const v = csNode[depth - 1];
      const e = csEdge[depth - 1];
      if (e < succStart[v + 1]) {
        csEdge[depth - 1] = e + 1;
        const w = succ[e];
        if (index[w] === -1) enter(w);
        else if (onStack[w] && index[w] < low[v]) low[v] = index[w];
        continue;
      }
      depth--;
      if (depth > 0) {
        const parent = csNode[depth - 1];
        if (low[v] < low[parent]) low[parent] = low[v];
      }
      if (low[v] === index[v]) {
        const comp: number[] = [];
        let w: number;
        do {
          w = stack[--sp];
          onStack[w] = 0;
          comp.push(w);
        } while (w !== v);
        components.push(comp);
      }
    }
  }

  // Tarjan emits sinks first; reverse for a topological order of the condensation.
  components.reverse();
  const order = new Int32Array(n);
  const scc = new Int32Array(n);
  const cyclic: boolean[] = [];
  const pos = new Int32Array(n);
  let k = 0;
  for (let id = 0; id < components.length; id++) {
    const comp = components[id];
    if (comp.length > 1) comp.sort((a, b) => rank[a] - rank[b]);
    let isCyclic = comp.length > 1;
    if (!isCyclic) {
      const v = comp[0];
      for (let e = succStart[v]; e < succStart[v + 1]; e++) if (succ[e] === v) isCyclic = true;
    }
    cyclic.push(isCyclic);
    for (const v of comp) {
      scc[v] = id;
      pos[v] = k;
      order[k++] = v;
    }
  }

  const integrator = new Uint8Array(n);
  for (let u = 0; u < n; u++) {
    if (!cyclic[scc[u]]) continue;
    for (let e = succStart[u]; e < succStart[u + 1]; e++) {
      const w = succ[e];
      if (scc[w] === scc[u] && pos[u] >= pos[w]) integrator[w] = 1;
    }
  }
  return { order, scc, cyclic, integrator };
}
