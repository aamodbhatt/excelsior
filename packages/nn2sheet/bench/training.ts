/** Measures in-sheet training throughput and transformer forward-pass latency (Node, single thread). */
import { readFileSync } from 'node:fs';
import { type GptWeights, compileMlp, compileTransformer, loadWorkbook } from '../src';

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));

const f = fixture('mlp-spiral.json');
const { doc } = compileMlp({
  x: f.x,
  y: f.y,
  init: f.init,
  hidden: f.config.hidden,
  learningRate: f.config.learning_rate,
});
const mlp = loadWorkbook(doc);
mlp.recalc({ iterations: 10 });
const steps = 2000;
const t0 = performance.now();
for (let i = 0; i < steps / 20; i++) mlp.recalc({ iterations: 20 });
const mlpMs = performance.now() - t0;

const { doc: gpt } = compileTransformer(fixture('names-gpt.json') as GptWeights);
const wb = loadWorkbook(gpt);
wb.recalc();
const prompts = ['a', 'em', 'chris', 'isabella', 'jonathanmarquez'];
const times: number[] = [];
for (let k = 0; k < 5; k++) {
  for (const p of prompts) {
    wb.setCell('model', 3, 1, p);
    const s = performance.now();
    wb.recalc();
    times.push(performance.now() - s);
  }
}
times.sort((a, b) => a - b);
console.log(
  JSON.stringify(
    {
      mlp: {
        steps,
        ms: mlpMs,
        stepsPerSecond: Math.round((steps / mlpMs) * 1000),
        cells: 'N=200 points, 16 hidden units',
      },
      transformer: {
        forwardMedianMs: times[Math.floor(times.length / 2)],
        forwardMaxMs: times[times.length - 1],
      },
    },
    null,
    2,
  ),
);
