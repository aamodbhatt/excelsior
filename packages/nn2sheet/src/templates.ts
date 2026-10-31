import { readFileSync } from 'node:fs';
import type { WorkbookDoc } from '@excelsior/doc';
import { compileMlp } from './mlp';
import { type GptWeights, compileTransformer } from './transformer';

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')) as T;
}

/** The "train a neural net in a spreadsheet" workbook, built from the NumPy reference dataset. */
export function neuralNetTemplate(): WorkbookDoc {
  const f = fixture<{
    x: number[][];
    y: number[];
    init: number[];
    config: { hidden: number; learning_rate: number };
  }>('mlp-spiral.json');
  return compileMlp({
    x: f.x,
    y: f.y,
    init: f.init,
    hidden: f.config.hidden,
    learningRate: f.config.learning_rate,
  }).doc;
}

/** The "transformer in a spreadsheet" workbook, built from the trained weights. */
export function transformerTemplate(): WorkbookDoc {
  return compileTransformer(fixture<GptWeights>('names-gpt.json')).doc;
}
