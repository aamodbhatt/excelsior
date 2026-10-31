import { lookupFunctions } from './lookup';
import { mathFunctions } from './math';
import { statFunctions } from './stats';
import { textFunctions } from './text';
import type { FunctionInfo, FunctionSpec } from './types';

const registry = new Map<string, FunctionSpec>();
for (const spec of [...mathFunctions, ...statFunctions, ...textFunctions, ...lookupFunctions]) {
  if (registry.has(spec.name)) throw new Error(`Duplicate function ${spec.name}`);
  registry.set(spec.name, spec);
}

/** Functions compiled as special forms (lazy or binding), listed here for autocomplete. */
const SPECIAL_FORMS: FunctionInfo[] = [
  {
    name: 'IF',
    signature: 'IF(logical_test, value_if_true, [value_if_false])',
    description: 'Chooses a value by a condition',
    category: 'logical',
  },
  {
    name: 'IFS',
    signature: 'IFS(test1, value1, [test2, value2], ...)',
    description: 'First value whose test is TRUE',
    category: 'logical',
  },
  {
    name: 'IFERROR',
    signature: 'IFERROR(value, value_if_error)',
    description: 'Replaces errors',
    category: 'logical',
  },
  { name: 'IFNA', signature: 'IFNA(value, value_if_na)', description: 'Replaces #N/A', category: 'logical' },
  {
    name: 'CHOOSE',
    signature: 'CHOOSE(index_num, value1, [value2], ...)',
    description: 'Picks a value by index',
    category: 'logical',
  },
  {
    name: 'SWITCH',
    signature: 'SWITCH(expression, value1, result1, ..., [default])',
    description: 'Matches a value against cases',
    category: 'logical',
  },
  {
    name: 'LET',
    signature: 'LET(name1, value1, ..., calculation)',
    description: 'Names intermediate results',
    category: 'lambda',
  },
  {
    name: 'LAMBDA',
    signature: 'LAMBDA([parameter1, ...], calculation)',
    description: 'Creates a reusable function',
    category: 'lambda',
  },
];

export function getFunction(name: string): FunctionSpec | undefined {
  return registry.get(name);
}

/** Every callable name with its documentation, sorted for autocomplete. */
export function listFunctions(): FunctionInfo[] {
  const builtins: FunctionInfo[] = [...registry.values()].map((s) => ({
    name: s.name,
    signature: s.signature,
    description: s.description,
    category: s.category,
  }));
  return [...builtins, ...SPECIAL_FORMS].sort((a, b) => a.name.localeCompare(b.name));
}
