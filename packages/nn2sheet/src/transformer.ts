import { formatA1 } from '@excelsior/engine';
import type { CellStyle, WorkbookDoc } from '@excelsior/doc';
import { type Block, DIVERGING, SheetBuilder } from './builder';

/** Weights exported by ml/excelsior_ml/train_transformer.py (float64 values of the trained tensors). */
export interface GptWeights {
  config: {
    vocab_size: number;
    block_size: number;
    d_model: number;
    n_heads: number;
    n_layers: number;
    mlp_ratio: number;
    head_dim: number;
  };
  vocab: string;
  params: number;
  metrics: Record<string, number>;
  tensors: Record<string, { shape: number[]; data: number[] }>;
}

export interface TransformerLayout {
  prompt: string;
  /** Model!<anchor> of the logits spill (T x V). */
  logits: Block;
  probs: Block;
  /** attention[layer][head] anchors (T x T). */
  attention: Block[][];
}

const LAMBDAS: Record<string, string> = {
  LAYERNORM:
    '=LAMBDA(x,g,b,LET(n,COLUMNS(x),mu,MMULT(x,SEQUENCE(n,1,1/n,0)),xc,x-mu,var,MMULT(xc*xc,SEQUENCE(n,1,1/n,0)),xc/SQRT(var+0.00001)*g+b))',
  GELU: '=LAMBDA(x,0.5*x*(1+TANH(SQRT(2/PI())*(x+0.044715*x^3))))',
  CAUSALATTENTION:
    '=LAMBDA(q,k,LET(t,ROWS(q),e,EXP(MMULT(q,TRANSPOSE(k))/SQRT(COLUMNS(q)))*(SEQUENCE(t)>=SEQUENCE(1,t)),e/MMULT(e,SEQUENCE(t,1,1,0))))',
  SOFTMAX: '=LAMBDA(z,LET(e,EXP(z-MAX(z)),e/SUM(e)))',
};

function reshape(t: { shape: number[]; data: number[] }): number[][] {
  const [rows, cols = 1] = t.shape.length === 1 ? [1, t.shape[0]] : t.shape;
  return Array.from({ length: rows }, (_, r) => t.data.slice(r * cols, (r + 1) * cols));
}

function transpose(m: number[][]): number[][] {
  return m[0].map((_, c) => m.map((row) => row[c]));
}

/**
 * Compiles a trained char-level GPT into a workbook. Weights live as constants on the Weights sheet
 * (exposed through defined names such as L0_Wq_h1); the Model sheet spells out the forward pass with
 * one spilling formula per tensor, so every activation and attention map is a visible cell range.
 */
export function compileTransformer(
  w: GptWeights,
  prompt = 'em',
): { doc: WorkbookDoc; layout: TransformerLayout } {
  const cfg = w.config;
  const d = cfg.d_model;
  const hd = cfg.head_dim;
  const model = new SheetBuilder('model', 'Model');
  const weights = new SheetBuilder('weights', 'Weights');
  const names: Record<string, string> = { ...LAMBDAS };

  // ---------------------------------------------------------------- Weights sheet
  let wr = 0;
  weights.set(0, 0, `Trained weights (${w.params} parameters). Linear layers are stored transposed: x · W.`, {
    bold: true,
  });
  wr = 2;
  const put = (name: string, m: number[][]): Block => {
    weights.label(wr, 0, name);
    const b = weights.matrix(wr + 1, 1, m, { fmt: '0.000' });
    names[name] = `=${b.ref()}`;
    wr += m.length + 2;
    return b;
  };
  const sub = (b: Block, r0: number, c0: number, rows: number, cols: number): string => {
    const a = formatA1(b.row + r0, b.col + c0).replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2');
    const z = formatA1(b.row + r0 + rows - 1, b.col + c0 + cols - 1).replace(/^([A-Z]+)(\d+)$/, '$$$1$$$2');
    return `=Weights!${a}:${z}`;
  };
  weights.label(wr, 0, 'VocabRow');
  [...w.vocab].forEach((ch, i) => weights.set(wr + 1, 1 + i, ch, { align: 'center', bold: true }));
  names.VocabRow = `=Weights!$B$${wr + 2}:$${formatA1(0, w.vocab.length).replace(/\d+$/, '')}$${wr + 2}`;
  wr += 3;
  const T = (key: string) => w.tensors[key];
  put('Wte', reshape(T('wte.weight')));
  put('Wpe', reshape(T('wpe.weight')));
  for (let l = 0; l < cfg.n_layers; l++) {
    const p = `blocks.${l}`;
    put(`L${l}_ln1_g`, reshape(T(`${p}.ln1.weight`)));
    put(`L${l}_ln1_b`, reshape(T(`${p}.ln1.bias`)));
    for (const m of ['q', 'k', 'v'] as const) {
      const W = put(`L${l}_W${m}`, transpose(reshape(T(`${p}.attn.${m}.weight`))));
      const B = put(`L${l}_b${m}`, reshape(T(`${p}.attn.${m}.bias`)));
      for (let h = 0; h < cfg.n_heads; h++) {
        names[`L${l}_W${m}_h${h}`] = sub(W, 0, h * hd, d, hd);
        names[`L${l}_b${m}_h${h}`] = sub(B, 0, h * hd, 1, hd);
      }
    }
    const Wo = put(`L${l}_Wo`, transpose(reshape(T(`${p}.attn.proj.weight`))));
    for (let h = 0; h < cfg.n_heads; h++) names[`L${l}_Wo_h${h}`] = sub(Wo, h * hd, 0, hd, d);
    put(`L${l}_bo`, reshape(T(`${p}.attn.proj.bias`)));
    put(`L${l}_ln2_g`, reshape(T(`${p}.ln2.weight`)));
    put(`L${l}_ln2_b`, reshape(T(`${p}.ln2.bias`)));
    put(`L${l}_Wfc`, transpose(reshape(T(`${p}.fc.weight`))));
    put(`L${l}_bfc`, reshape(T(`${p}.fc.bias`)));
    put(`L${l}_Wout`, transpose(reshape(T(`${p}.out.weight`))));
    put(`L${l}_bout`, reshape(T(`${p}.out.bias`)));
  }
  put('LNf_g', reshape(T('ln_f.weight')));
  put('LNf_b', reshape(T('ln_f.bias')));
  put('Whead', transpose(reshape(T('head.weight'))));
  put('bhead', reshape(T('head.bias')));
  weights.colWidth(0, 90);

  // ---------------------------------------------------------------- Model sheet: controls
  const L = cfg.block_size;
  model.set(0, 0, 'A transformer, running in spreadsheet formulas', { bold: true, size: 16 });
  model.set(
    1,
    0,
    `${cfg.n_layers} layers · ${cfg.n_heads} heads · d=${d} · ${w.params.toLocaleString('en-US')} parameters, trained on names. Type a prompt, then Generate.`,
    { color: '#5f6368' },
  );
  model.label(3, 0, 'Prompt', { bold: true });
  model.set(3, 1, prompt, { bold: true, fill: '#fff6d5' });
  model.label(4, 0, 'Context', { bold: true });
  model.set(4, 1, `=RIGHT("."&LOWER(B4),${L})`);
  model.label(5, 0, 'Next char', { bold: true });
  model.set(5, 1, '=INDEX(VocabRow,1,MATCH(MAX(Probs),Probs,0))', { bold: true, size: 15, color: '#2e6fe4' });
  model.label(7, 0, 'Top 5 next characters');
  model.set(8, 1, '=MAP(SEQUENCE(5),LAMBDA(k,LARGE(Probs,k)))', { fmt: '0.0%' });
  model.set(8, 0, '=MAP(B9#,LAMBDA(p,INDEX(VocabRow,1,MATCH(p,Probs,0))))', { align: 'center', bold: true });
  for (let r = 9; r < 13; r++) {
    model.style(r, 0, { align: 'center', bold: true });
    model.style(r, 1, { fmt: '0.0%' });
  }
  model.colorScale('B9:B13', {
    min: { type: 'num', value: 0, color: '#ffffff' },
    max: { type: 'num', value: 1, color: '#34a853' },
  });
  model.colWidth(0, 96);
  model.colWidth(1, 120);
  model.colWidth(2, 24);
  // The attention panel (and the gaps between heads) uses narrow, square-ish columns.
  for (let c = 3; c < 4 + cfg.n_heads * (L + 3); c++) model.colWidth(c, 22);
  names.Prompt = '=Model!$B$4';
  names.Context = '=Model!$B$5';
  names.NextChar = '=Model!$B$6';

  // ---------------------------------------------------------------- forward pass ("under the hood")
  let r = 46;
  model.set(r - 2, 0, 'Under the hood: the forward pass, one spilling formula per tensor', {
    bold: true,
    size: 14,
  });
  const ACT = { fmt: '0.00' };
  const step = (
    label: string,
    text: string,
    rows: number,
    cols: number,
    col = 1,
    style: CellStyle = ACT,
  ): Block => {
    model.label(r, col, label);
    const b = model.formula(r + 1, col, text, rows, cols, style);
    return b;
  };
  const advance = (rows: number) => {
    r += rows + 3;
  };
  const chars = step('Chars', `=MID(Context,SEQUENCE(LEN(Context)),1)`, L, 1, 1, {
    align: 'center',
    bold: true,
  });
  names.Chars = `=${chars.spill()}`;
  const ids = step('Token ids', '=IFERROR(MATCH(Chars,VocabRow,0),1)', L, 1, 2, { fmt: '0' });
  const x0 = step(
    'Embeddings: Wte[id] + Wpe[pos]',
    `=INDEX(Wte,${ids.spill(false)},SEQUENCE(1,${d}))+INDEX(Wpe,SEQUENCE(ROWS(Chars)),SEQUENCE(1,${d}))`,
    L,
    d,
    4,
  );
  model.colorScale(`${formatA1(x0.row, x0.col)}:${formatA1(x0.row + L - 1, x0.col + d - 1)}`, DIVERGING);
  advance(L);
  let x = x0;
  const attention: Block[][] = [];
  for (let l = 0; l < cfg.n_layers; l++) {
    const ln1 = step(
      `Layer ${l + 1} · LayerNorm 1`,
      `=LAYERNORM(${x.spill(false)},L${l}_ln1_g,L${l}_ln1_b)`,
      L,
      d,
    );
    advance(L);
    const heads: Block[] = [];
    const outs: Block[] = [];
    attention.push(heads);
    for (let h = 0; h < cfg.n_heads; h++) {
      const q = step(
        `L${l + 1} head ${h + 1} · Q`,
        `=MMULT(${ln1.spill(false)},L${l}_Wq_h${h})+L${l}_bq_h${h}`,
        L,
        hd,
        1,
      );
      const k = model.formula(
        r + 1,
        1 + hd + 1,
        `=MMULT(${ln1.spill(false)},L${l}_Wk_h${h})+L${l}_bk_h${h}`,
        L,
        hd,
        ACT,
      );
      const v = model.formula(
        r + 1,
        1 + 2 * (hd + 1),
        `=MMULT(${ln1.spill(false)},L${l}_Wv_h${h})+L${l}_bv_h${h}`,
        L,
        hd,
        ACT,
      );
      model.label(r, 1 + hd + 1, 'K');
      model.label(r, 1 + 2 * (hd + 1), 'V');
      advance(L);
      // The attention map is drawn in the top panel, where it is also computed.
      const top = 3 + l * (L + 4);
      const left = 4 + h * (L + 3);
      model.label(top - 1, left + 1, `Layer ${l + 1} · head ${h + 1} attention`);
      model.set(top, left + 1, '=TRANSPOSE(Chars)', { align: 'center', bold: true, color: '#5f6368' });
      model.set(top + 1, left, '=Chars', { align: 'center', bold: true, color: '#5f6368' });
      const att = model.formula(top + 1, left + 1, `=CAUSALATTENTION(${q.spill()},${k.spill()})`, L, L, {
        fmt: ';;;',
      });
      model.colorScale(`${formatA1(att.row, att.col)}:${formatA1(att.row + L - 1, att.col + L - 1)}`, {
        min: { type: 'num', value: 0, color: '#ffffff' },
        max: { type: 'num', value: 1, color: '#6d3fd6' },
      });
      for (let c = 0; c <= L; c++) model.colWidth(left + c, c === 0 ? 20 : 22);
      heads.push(att);
      const o = step(
        `L${l + 1} head ${h + 1} · attention · V`,
        `=MMULT(${att.spill()},${v.spill(false)})`,
        L,
        hd,
      );
      outs.push(o);
      advance(L);
    }
    const attnSum = outs.map((o, h) => `MMULT(${o.spill(false)},L${l}_Wo_h${h})`).join('+');
    const x1 = step(
      `Layer ${l + 1} · residual after attention`,
      `=${x.spill(false)}+${attnSum}+L${l}_bo`,
      L,
      d,
    );
    advance(L);
    const ln2 = step(
      `Layer ${l + 1} · LayerNorm 2`,
      `=LAYERNORM(${x1.spill(false)},L${l}_ln2_g,L${l}_ln2_b)`,
      L,
      d,
    );
    advance(L);
    const hid = step(
      `Layer ${l + 1} · MLP hidden (GELU)`,
      `=GELU(MMULT(${ln2.spill(false)},L${l}_Wfc)+L${l}_bfc)`,
      L,
      d * cfg.mlp_ratio,
    );
    advance(L);
    x = step(
      `Layer ${l + 1} · residual after MLP`,
      `=${x1.spill(false)}+MMULT(${hid.spill(false)},L${l}_Wout)+L${l}_bout`,
      L,
      d,
    );
    model.colorScale(`${formatA1(x.row, x.col)}:${formatA1(x.row + L - 1, x.col + d - 1)}`, DIVERGING);
    advance(L);
  }
  const lnf = step('Final LayerNorm', `=LAYERNORM(${x.spill(false)},LNf_g,LNf_b)`, L, d);
  advance(L);
  const logits = step(
    'Logits (one row per position)',
    `=MMULT(${lnf.spill(false)},Whead)+bhead`,
    L,
    w.vocab.length,
  );
  advance(L);
  model.label(r, 0, 'Next-char distribution');
  [...w.vocab].forEach((ch, i) => model.set(r + 1, 1 + i, ch, { align: 'center', bold: true }));
  const probs = model.formula(
    r + 2,
    1,
    `=SOFTMAX(INDEX(${logits.spill(false)},ROWS(Chars),0))`,
    1,
    w.vocab.length,
    { fmt: '0%' },
  );
  model.colorScale(
    `${formatA1(probs.row, probs.col)}:${formatA1(probs.row, probs.col + w.vocab.length - 1)}`,
    {
      min: { type: 'num', value: 0, color: '#ffffff' },
      max: { type: 'max', color: '#34a853' },
    },
  );
  names.Probs = `=${probs.spill()}`;
  names.Logits = `=${logits.spill()}`;

  const doc: WorkbookDoc = {
    schema: 1,
    sheets: [model.doc, weights.doc],
    names,
    calc: { iterative: false, maxIterations: 100, maxChange: 0.001, seed: null },
    iterationState: null,
    watches: ['Prompt', 'NextChar'],
    actions: [{ id: 'generate', label: 'Generate', kind: 'append', target: 'Model!B4', source: 'NextChar' }],
  };
  return { doc, layout: { prompt: 'Model!B4', logits, probs, attention } };
}
