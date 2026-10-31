import { Workbook, formatA1 } from '@excelsior/engine';
import { type WorkbookDoc, applyOp, toEngineSnapshot } from '@excelsior/doc';
import { Block, DIVERGING, SheetBuilder } from './builder';

/** The dataset and initial parameters, exactly as the NumPy reference produced them. */
export interface MlpSpec {
  x: number[][];
  y: number[];
  /** Neuron-table order: per hidden neuron [w_x, w_y, b, v], then the output bias c. */
  init: number[];
  hidden: number;
  learningRate: number;
  /** Loss-history slots and the step stride between them. */
  historySlots?: number;
  historyStride?: number;
  /** Heat-map resolution (cells per side). */
  grid?: number;
}

/** Where the compiled sheet keeps things, so tests and the UI can find them without guessing. */
export interface MlpLayout {
  neurons: Block;
  outputBias: string;
  loss: string;
  step: string;
  heatmap: Block;
}

const NUM = { fmt: '0.000' };

/**
 * Compiles a 2-layer tanh MLP with a sigmoid output into a workbook whose formulas run the forward
 * pass, the backward pass and the gradient-descent update. With iterative calculation enabled, each
 * iteration is exactly one full-batch gradient step:
 *
 *   Train (sheet 1, evaluated first)   parameters: W <- W - lr * dL/dW      (integrators)
 *   Net   (sheet 2, row 5, left->right) Z1 -> A1 -> Z2 -> P -> dZ2 -> dZ1 -> gradients
 *
 * Within a cycle the engine evaluates cells row-major, so the parameters read the gradients of the
 * previous iteration (a back edge) and everything on Net reads the freshly updated parameters.
 */
export function compileMlp(spec: MlpSpec): { doc: WorkbookDoc; layout: MlpLayout } {
  const N = spec.x.length;
  const H = spec.hidden;
  const G = spec.grid ?? 36;
  const slots = spec.historySlots ?? 400;
  const stride = spec.historyStride ?? 10;
  const train = new SheetBuilder('train', 'Train');
  const net = new SheetBuilder('net', 'Net');

  // ---------------------------------------------------------------- Net: data and constants
  const R = 4; // anchor row (0-based) for every block on Net
  net.set(0, 0, 'The network, one block per equation. Every block is a single spilling formula.', {
    bold: true,
    size: 14,
  });
  const header = (col: number, title: string, dims: string) => {
    net.label(R - 2, col, title);
    net.set(R - 1, col, dims, { color: '#80868b', italic: true });
  };
  header(0, 'X (data)', `${N} x 2`);
  const X = net.matrix(R, 0, spec.x, NUM);
  header(2, 'y', `${N} x 1`);
  const Y = net.matrix(
    R,
    2,
    spec.y.map((v) => [v]),
  );
  header(3, 'Init', `${H} x 4`);
  const initRows = Array.from({ length: H }, (_, i) => spec.init.slice(i * 4, i * 4 + 4));
  const INIT = net.matrix(R, 3, initRows, NUM);
  net.set(R + H, 3, spec.init[H * 4], NUM);

  // ---------------------------------------------------------------- Train: controls and parameters
  train.set(0, 0, 'Training a neural network with spreadsheet formulas', { bold: true, size: 16 });
  train.set(1, 0, 'Iterative calculation is on: every iteration is one gradient-descent step. Press Play.', {
    color: '#5f6368',
  });
  const controls: [string, string | number | boolean][] = [
    ['Learning rate', spec.learningRate],
    ['Reset', false],
    ['Step', '=IF(Reset,0,B6+1)'],
    ['Loss', '=Loss_'],
    ['Accuracy', '=Accuracy_'],
  ];
  controls.forEach(([label, value], i) => {
    train.label(3 + i, 0, label, { bold: true });
    train.set(
      3 + i,
      1,
      value,
      i === 3 ? { fmt: '0.0000', bold: true } : i === 4 ? { fmt: '0.0%', bold: true } : undefined,
    );
  });
  train.label(9, 0, 'Hidden neurons');
  ['w_x', 'w_y', 'bias', 'out'].forEach((h, j) =>
    train.label(10, 1 + j, h, { bold: true, align: 'right', color: '#5f6368' }),
  );
  const P0 = 11; // first neuron row
  const neurons = new Block('Train', P0, 1, H, 4);

  // ---------------------------------------------------------------- Net: forward and backward pass
  let col = 8;
  const place = (
    title: string,
    dims: string,
    text: string,
    rows: number,
    cols: number,
    styled = true,
  ): Block => {
    header(col, title, dims);
    const b = net.formula(R, col, text, rows, cols, styled ? NUM : undefined);
    col += cols + 1;
    return b;
  };
  const Win = `Train!$B$${P0 + 1}:$C$${P0 + H}`;
  const Bh = `Train!$D$${P0 + 1}:$D$${P0 + H}`;
  const Wout = `Train!$E$${P0 + 1}:$E$${P0 + H}`;
  const Bout = `Train!$E$${P0 + H + 1}`;
  const Z1 = place(
    'Z1 = X·Wᵀ + b',
    `${N} x ${H}`,
    `=MMULT(${X.ref(false)},TRANSPOSE(${Win}))+TRANSPOSE(${Bh})`,
    N,
    H,
  );
  const A1 = place('A1 = tanh(Z1)', `${N} x ${H}`, `=TANH(${Z1.spill(false)})`, N, H);
  const Z2 = place('Z2 = A1·v + c', `${N} x 1`, `=MMULT(${A1.spill(false)},${Wout})+${Bout}`, N, 1);
  const P = place('P = σ(Z2)', `${N} x 1`, `=1/(1+EXP(-${Z2.spill(false)}))`, N, 1);
  const dZ2 = place('dZ2 = (P - y) / N', `${N} x 1`, `=(${P.spill(false)}-${Y.ref(false)})/${N}`, N, 1);
  const dZ1 = place(
    'dZ1 = dZ2·vᵀ ⊙ (1 - A1²)',
    `${N} x ${H}`,
    `=MMULT(${dZ2.spill(false)},TRANSPOSE(${Wout}))*(1-${A1.spill(false)}^2)`,
    N,
    H,
  );
  const gW = place('dL/dW', `${H} x 2`, `=MMULT(TRANSPOSE(${dZ1.spill(false)}),${X.ref(false)})`, H, 2);
  const gB = place('dL/db', `${H} x 1`, `=MMULT(TRANSPOSE(${dZ1.spill(false)}),SEQUENCE(${N},1,1,0))`, H, 1);
  const gV = place('dL/dv', `${H} x 1`, `=MMULT(TRANSPOSE(${A1.spill(false)}),${dZ2.spill(false)})`, H, 1);
  const gC = place('dL/dc', '1 x 1', `=SUM(${dZ2.spill(false)})`, 1, 1);
  // Gradient cell for parameter column j of neuron i, matching the neuron-table layout.
  const gradRefs: ((i: number) => string)[] = [
    (i) => `Net!${gW.cell(i, 0)}`,
    (i) => `Net!${gW.cell(i, 1)}`,
    (i) => `Net!${gB.cell(i, 0)}`,
    (i) => `Net!${gV.cell(i, 0)}`,
  ];

  // Parameter update formulas (integrators): each reads itself and a gradient on the later sheet.
  for (let i = 0; i < H; i++) {
    train.set(P0 + i, 0, i + 1, { color: '#80868b', align: 'right' });
    for (let j = 0; j < 4; j++) {
      const self = formatA1(P0 + i, 1 + j);
      train.set(
        P0 + i,
        1 + j,
        `=IF(Reset,Net!${INIT.cell(i, j)},${self}-LearningRate*${gradRefs[j](i)})`,
        NUM,
      );
    }
  }
  const cAddr = formatA1(P0 + H, 4);
  train.label(P0 + H, 0, 'output bias', { bold: false, color: '#5f6368' });
  train.set(
    P0 + H,
    4,
    `=IF(Reset,Net!${formatA1(R + H, 3)},${cAddr}-LearningRate*Net!${gC.cell(0, 0)})`,
    NUM,
  );
  train.colorScale(`B${P0 + 1}:E${P0 + H + 1}`, DIVERGING);

  // ---------------------------------------------------------------- metrics and loss history
  col += 1;
  header(col, 'Loss', 'BCE');
  net.set(
    R,
    col,
    `=SUMPRODUCT(IF(${Z2.spill(false)}>0,${Z2.spill(false)},0)-${Y.ref(false)}*${Z2.spill(false)}+LN(1+EXP(-ABS(${Z2.spill(false)}))))/${N}`,
    {
      fmt: '0.000000',
    },
  );
  const lossCell = `Net!$${formatA1(R, col).replace(/(\d+)$/, '$$$1')}`;
  header(col + 1, 'Accuracy', '');
  net.set(R, col + 1, `=SUMPRODUCT(--((${Z2.spill(false)}>0)=(${Y.ref(false)}=1)))/${N}`, { fmt: '0.0%' });
  const accCell = `Net!$${formatA1(R, col + 1).replace(/(\d+)$/, '$$$1')}`;
  col += 3;
  header(col, 'Step', 'history');
  header(col + 1, 'Loss', `${slots} slots`);
  for (let k = 0; k < slots; k++) {
    net.set(R + k, col, k * stride);
    const self = formatA1(R + k, col + 1);
    net.set(R + k, col + 1, `=IF(Step=${k * stride},Loss,IF(Reset,"",${self}))`, { fmt: '0.0000' });
  }
  const histX = `Net!${formatA1(R, col)}:${formatA1(R + slots - 1, col)}`;
  const histY = `Net!${formatA1(R, col + 1)}:${formatA1(R + slots - 1, col + 1)}`;
  col += 3;

  // ---------------------------------------------------------------- decision-boundary grid
  const lo = -1.15;
  const span = 2.3;
  const d = span / G;
  header(col, 'Grid x', `${G * G} x 1`);
  const GX = net.formula(R, col, `=${lo}+(MOD(SEQUENCE(${G * G})-1,${G})+0.5)*${d}`, G * G, 1);
  header(col + 1, 'Grid y', `${G * G} x 1`);
  const GY = net.formula(R, col + 1, `=${-lo}-(INT((SEQUENCE(${G * G})-1)/${G})+0.5)*${d}`, G * G, 1);
  col += 3;
  const GA = place(
    'tanh(grid·Wᵀ + b)',
    `${G * G} x ${H}`,
    `=TANH(${GX.spill(false)}*TRANSPOSE(INDEX(${Win},0,1))+${GY.spill(false)}*TRANSPOSE(INDEX(${Win},0,2))+TRANSPOSE(${Bh}))`,
    G * G,
    H,
    false,
  );
  const GP = place(
    'P(grid)',
    `${G * G} x 1`,
    `=1/(1+EXP(-(MMULT(${GA.spill(false)},${Wout})+${Bout})))`,
    G * G,
    1,
    false,
  );
  const GRID = place(
    'P as a grid',
    `${G} x ${G}`,
    `=INDEX(${GP.spill(false)},(SEQUENCE(${G})-1)*${G}+SEQUENCE(1,${G}))`,
    G,
    G,
    false,
  );
  // Data points snapped to the grid, drawn as glyphs on top of the heat-map (static, so constants).
  header(col, 'Markers', `${G} x ${G}`);
  const marks: string[][] = Array.from({ length: G }, () => Array(G).fill(''));
  spec.x.forEach(([px, py], i) => {
    const c = Math.min(G - 1, Math.max(0, Math.floor((px - lo) / d)));
    const r = Math.min(G - 1, Math.max(0, Math.floor((-lo - py) / d)));
    if (marks[r][c] !== '●') marks[r][c] = spec.y[i] > 0.5 ? '●' : '○';
  });
  marks.forEach((row, r) => row.forEach((m, c) => m && net.set(R + r, col + c, m)));
  const MARKS = `Net!${formatA1(R, col)}:${formatA1(R + G - 1, col + G - 1)}`;

  // ---------------------------------------------------------------- Train: heat-map and charts
  const HM_ROW = 3;
  const HM_COL = 6;
  const heat = train.formula(HM_ROW, HM_COL, `=IF(${MARKS}="",${GRID.spill()},${MARKS})`, G, G, {
    fmt: ';;;',
    align: 'center',
    size: 9,
  });
  train.label(HM_ROW - 1, HM_COL, 'Decision boundary: P(class ●) over the input plane', { bold: true });
  train.colorScale(heat.range(), {
    min: { type: 'num', value: 0, color: '#e4572e' },
    mid: { type: 'num', value: 0.5, color: '#ffffff' },
    max: { type: 'num', value: 1, color: '#2e6fe4' },
  });
  for (let c = 0; c < G; c++) train.colWidth(HM_COL + c, 14);
  for (let r = 0; r < G; r++) train.rowHeight(HM_ROW + r, 14);
  train.colWidth(0, 104);
  for (let c = 1; c <= 4; c++) train.colWidth(c, 62);
  train.colWidth(5, 18);
  train.chart({
    id: 'loss',
    type: 'line',
    title: 'Training loss',
    series: [{ name: 'loss', x: histX, y: histY, color: '#e4572e' }],
    anchor: { row: HM_ROW, col: HM_COL + G + 1 },
    width: 420,
    height: 250,
    yRange: [0, 0.8],
  });
  train.chart({
    id: 'data',
    type: 'scatter',
    title: 'Two spirals',
    series: [
      {
        name: 'class ○',
        x: `Net!A${R + 1}:A${R + N / 2}`,
        y: `Net!B${R + 1}:B${R + N / 2}`,
        color: '#e4572e',
      },
      {
        name: 'class ●',
        x: `Net!A${R + N / 2 + 1}:A${R + N}`,
        y: `Net!B${R + N / 2 + 1}:B${R + N}`,
        color: '#2e6fe4',
      },
    ],
    anchor: { row: HM_ROW + 19, col: HM_COL + G + 1 },
    width: 420,
    height: 250,
    xRange: [-1.15, 1.15],
    yRange: [-1.15, 1.15],
  });

  const doc: WorkbookDoc = {
    schema: 1,
    sheets: [train.doc, net.doc],
    names: {
      LearningRate: '=Train!$B$4',
      Reset: '=Train!$B$5',
      Step: '=Train!$B$6',
      Loss_: `=${lossCell}`,
      Accuracy_: `=${accCell}`,
      Loss: '=Train!$B$7',
      Accuracy: '=Train!$B$8',
    },
    calc: { iterative: true, maxIterations: 1, maxChange: 0, seed: null },
    iterationState: null,
    watches: ['Step', 'Loss', 'Accuracy'],
    actions: [{ id: 'reset', label: 'Reset', kind: 'pulse', target: 'Train!B5' }],
  };
  doc.iterationState = initialState(doc);
  return {
    doc,
    layout: { neurons, outputBias: `Train!${cAddr}`, loss: 'Train!B7', step: 'Train!B6', heatmap: heat },
  };
}

/** Runs one iteration with Reset = TRUE to capture the step-0 state, then stores Reset = FALSE. */
function initialState(doc: WorkbookDoc): WorkbookDoc['iterationState'] {
  applyOp(doc, { t: 'cells', sheet: 'train', cells: { B5: { v: 'TRUE' } } });
  const wb = loadWorkbook(doc);
  wb.recalc();
  applyOp(doc, { t: 'cells', sheet: 'train', cells: { B5: { v: 'FALSE' } } });
  return wb.getIterationState();
}

/** Builds an engine workbook from a document (used by tests, templates and exports). */
export function loadWorkbook(doc: WorkbookDoc): Workbook {
  const snap = toEngineSnapshot(doc);
  const wb = new Workbook();
  wb.setSettings(snap.settings);
  for (const s of snap.sheets) wb.addSheet(s.id, s.name);
  for (const [name, f] of Object.entries(snap.names)) wb.defineName(name, f);
  for (const s of snap.sheets) for (const [r, c, v] of s.cells) wb.setCell(s.id, r, c, v);
  if (snap.iterationState) wb.setIterationState(snap.iterationState);
  return wb;
}
