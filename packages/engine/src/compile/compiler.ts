import { MAX_COLS, MAX_ROWS, type Rect } from '../core/address';
import { toBoolean } from '../core/coerce';
import { CellError, Errors } from '../core/errors';
import {
  ArrayValue,
  LambdaValue,
  type NumMatrix,
  RangeRef,
  type Scalar,
  type Value,
  isGrid,
} from '../core/values';
import { getFunction } from '../functions/registry';
import type { ArrayLiteralItem, Node, RefNode } from '../parser/ast';
import { type Env, type Thunk, withEnv } from './context';
import {
  arithmetic,
  compare,
  concat,
  deref,
  implicitIntersection,
  isGridLike,
  liftN,
  negate,
  percent,
  rangeUnion,
  spillRange,
  unaryPlus,
} from './ops';

/** One coordinate of a dependency, either absolute or relative to the formula's own cell. */
interface Coord {
  rel: boolean;
  v: number;
}

/** A static precedent of a formula, resolved per cell because relative parts depend on the anchor. */
export interface DepTemplate {
  sheet: string | null;
  r1: Coord;
  c1: Coord;
  r2: Coord;
  c2: Coord;
}

export interface CompiledFormula {
  readonly thunk: Thunk;
  readonly deps: DepTemplate[];
  /** Upper-cased workbook names the formula reads (excluding LET/LAMBDA locals). */
  readonly names: string[];
  readonly volatile: boolean;
}

export interface ResolvedDep {
  sheet: string | null;
  rect: Rect;
}

/** Resolves dependency templates at a concrete cell, dropping references that fall off the grid. */
export function resolveDeps(deps: DepTemplate[], row: number, col: number): ResolvedDep[] {
  const out: ResolvedDep[] = [];
  for (const d of deps) {
    const r1 = d.r1.rel ? row + d.r1.v : d.r1.v;
    const r2 = d.r2.rel ? row + d.r2.v : d.r2.v;
    const c1 = d.c1.rel ? col + d.c1.v : d.c1.v;
    const c2 = d.c2.rel ? col + d.c2.v : d.c2.v;
    const rect = { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) };
    if (rect.r1 < 0 || rect.c1 < 0 || rect.r2 >= MAX_ROWS || rect.c2 >= MAX_COLS) continue;
    out.push({ sheet: d.sheet, rect });
  }
  return out;
}

/** Serializes an AST with relative references expressed as offsets, so fill-down copies share one key. */
export function shapeKey(node: Node, row: number, col: number): string {
  const parts: string[] = [];
  const walk = (n: Node): void => {
    switch (n.kind) {
      case 'ref': {
        const s = n.start;
        const e = n.end;
        parts.push(
          `R(${n.sheet ?? ''}|${n.type}|${s.rowAbs ? s.row : `~${s.row - row}`},${s.colAbs ? s.col : `~${s.col - col}`},${
            e.rowAbs ? e.row : `~${e.row - row}`
          },${e.colAbs ? e.col : `~${e.col - col}`})`,
        );
        return;
      }
      case 'call':
        parts.push(`C(${n.name}`);
        for (const a of n.args) walk(a);
        parts.push(')');
        return;
      case 'invoke':
        parts.push('I(');
        walk(n.callee);
        for (const a of n.args) walk(a);
        parts.push(')');
        return;
      case 'unary':
      case 'postfix':
        parts.push(`${n.kind}${n.op}(`);
        walk(n.operand);
        parts.push(')');
        return;
      case 'binary':
        parts.push(`B${n.op}(`);
        walk(n.left);
        parts.push(',');
        walk(n.right);
        parts.push(')');
        return;
      default:
        parts.push(JSON.stringify(n));
    }
  };
  walk(node);
  return parts.join('');
}

function arrayItemValue(item: ArrayLiteralItem): Scalar {
  if (typeof item === 'object') return new CellError(item.error);
  return item;
}

class Scope {
  constructor(
    readonly names: string[],
    readonly parent: Scope | null,
  ) {}

  lookup(name: string): { depth: number; index: number } | null {
    let depth = 0;
    for (let s: Scope | null = this; s; s = s.parent, depth++) {
      const index = s.names.indexOf(name);
      if (index >= 0) return { depth, index };
    }
    return null;
  }
}

function envAt(env: Env | null, depth: number): Env {
  let e = env!;
  for (let i = 0; i < depth; i++) e = e.parent!;
  return e;
}

function callLambda(fn: Value, args: Value[]): Value {
  if (!(fn instanceof LambdaValue)) return fn instanceof CellError ? fn : Errors.value;
  if (args.length !== fn.arity) return Errors.value;
  return fn.invoke(args);
}

class Compiler {
  readonly deps: DepTemplate[] = [];
  readonly names = new Set<string>();
  volatile = false;

  constructor(
    private readonly anchorRow: number,
    private readonly anchorCol: number,
  ) {}

  compile(node: Node, scope: Scope | null): Thunk {
    switch (node.kind) {
      case 'number':
      case 'string':
      case 'boolean': {
        const v = node.value;
        return () => v;
      }
      case 'error': {
        const e = new CellError(node.code);
        return () => e;
      }
      case 'missing':
        return () => null;
      case 'array': {
        const arr = ArrayValue.fromRows(node.rows.map((r) => r.map(arrayItemValue)));
        return () => arr;
      }
      case 'ref':
        return this.ref(node);
      case 'name':
        return this.name(node.name, scope);
      case 'unary': {
        const operand = this.compile(node.operand, scope);
        if (node.op === '-') return (ctx) => negate(operand(ctx));
        if (node.op === '+') return (ctx) => unaryPlus(operand(ctx));
        return (ctx) => implicitIntersection(operand(ctx), ctx.row, ctx.col);
      }
      case 'postfix': {
        const operand = this.compile(node.operand, scope);
        if (node.op === '%') return (ctx) => percent(operand(ctx));
        return (ctx) => spillRange(operand(ctx));
      }
      case 'binary': {
        const l = this.compile(node.left, scope);
        const r = this.compile(node.right, scope);
        switch (node.op) {
          case '+':
          case '-':
          case '*':
          case '/':
          case '^': {
            const op = node.op;
            return (ctx) => arithmetic(op, l(ctx), r(ctx));
          }
          case '&':
            return (ctx) => concat(l(ctx), r(ctx));
          case ':':
            return (ctx) => rangeUnion(l(ctx), r(ctx));
          default: {
            const op = node.op;
            return (ctx) => compare(op, l(ctx), r(ctx));
          }
        }
      }
      case 'invoke': {
        const callee = this.compile(node.callee, scope);
        const args = node.args.map((a) => this.compile(a, scope));
        return (ctx) =>
          callLambda(
            callee(ctx),
            args.map((a) => a(ctx)),
          );
      }
      case 'call':
        return this.call(node.name, node.args, scope);
    }
  }

  private coord(rel: boolean, value: number, anchor: number): Coord {
    return rel ? { rel: true, v: value - anchor } : { rel: false, v: value };
  }

  private ref(node: RefNode): Thunk {
    const { start: s, end: e } = node;
    const dep: DepTemplate = {
      sheet: node.sheet,
      r1: this.coord(!s.rowAbs, s.row, this.anchorRow),
      c1: this.coord(!s.colAbs, s.col, this.anchorCol),
      r2: this.coord(!e.rowAbs, e.row, this.anchorRow),
      c2: this.coord(!e.colAbs, e.col, this.anchorCol),
    };
    this.deps.push(dep);
    const sheetName = node.sheet;
    const { r1, c1, r2, c2 } = dep;
    return (ctx) => {
      const sheet = sheetName === null ? ctx.sheet : ctx.host.sheetByName(sheetName);
      if (!sheet) return Errors.ref;
      const a = r1.rel ? ctx.row + r1.v : r1.v;
      const b = r2.rel ? ctx.row + r2.v : r2.v;
      const c = c1.rel ? ctx.col + c1.v : c1.v;
      const d = c2.rel ? ctx.col + c2.v : c2.v;
      if (
        a < 0 ||
        b < 0 ||
        c < 0 ||
        d < 0 ||
        a >= MAX_ROWS ||
        b >= MAX_ROWS ||
        c >= MAX_COLS ||
        d >= MAX_COLS
      ) {
        return Errors.ref;
      }
      return new RangeRef(sheet, Math.min(a, b), Math.min(c, d), Math.max(a, b), Math.max(c, d));
    };
  }

  private name(raw: string, scope: Scope | null): Thunk {
    const name = raw.toUpperCase();
    const local = scope?.lookup(name);
    if (local) {
      const { depth, index } = local;
      return (ctx) => envAt(ctx.env, depth).vals[index];
    }
    this.names.add(name);
    return (ctx) => ctx.host.evaluateName(name, ctx) ?? Errors.name;
  }

  private call(name: string, argNodes: Node[], scope: Scope | null): Thunk {
    const special = this.special(name, argNodes, scope);
    if (special) return special;
    const spec = getFunction(name);
    const args = argNodes.map((a) => this.compile(a, scope));
    if (!spec) {
      // Not a built-in: it may be a LET-bound or workbook-level LAMBDA.
      const callee = this.name(name, scope);
      return (ctx) => {
        const fn = callee(ctx);
        if (!(fn instanceof LambdaValue)) return fn instanceof CellError ? fn : Errors.name;
        return callLambda(
          fn,
          args.map((a) => a(ctx)),
        );
      };
    }
    if (args.length < spec.minArgs || args.length > spec.maxArgs) {
      const msg = `${spec.name} expects ${spec.minArgs === spec.maxArgs ? spec.minArgs : `${spec.minArgs}-${spec.maxArgs}`} arguments`;
      const err = new CellError('#VALUE!', msg);
      return () => err;
    }
    if (spec.volatile) this.volatile = true;
    const n = args.length;
    if (n === 1) {
      const a0 = args[0];
      return (ctx) => spec.call([a0(ctx)], ctx);
    }
    if (n === 2) {
      const [a0, a1] = args;
      return (ctx) => spec.call([a0(ctx), a1(ctx)], ctx);
    }
    return (ctx) => {
      const vals: Value[] = new Array(n);
      for (let i = 0; i < n; i++) vals[i] = args[i](ctx);
      return spec.call(vals, ctx);
    };
  }

  /** Functions with lazy or binding semantics are compiled here instead of in the registry. */
  private special(name: string, argNodes: Node[], scope: Scope | null): Thunk | null {
    switch (name) {
      case 'IF':
        return this.ifForm(argNodes, scope);
      case 'IFERROR':
      case 'IFNA':
        return this.ifErrorForm(name, argNodes, scope);
      case 'IFS':
        return this.ifsForm(argNodes, scope);
      case 'CHOOSE':
        return this.chooseForm(argNodes, scope);
      case 'SWITCH':
        return this.switchForm(argNodes, scope);
      case 'LET':
        return this.letForm(argNodes, scope);
      case 'LAMBDA':
        return this.lambdaForm(argNodes, scope);
      default:
        return null;
    }
  }

  private arity(name: string, argNodes: Node[], min: number, max: number): Thunk | null {
    if (argNodes.length >= min && argNodes.length <= max) return null;
    const err = new CellError('#VALUE!', `${name} has the wrong number of arguments`);
    return () => err;
  }

  private ifForm(argNodes: Node[], scope: Scope | null): Thunk {
    const bad = this.arity('IF', argNodes, 2, 3);
    if (bad) return bad;
    const [cond, yes, no] = argNodes.map((a) => this.compile(a, scope));
    const noBranch: Thunk = no ?? (() => false);
    return (ctx) => {
      const c = deref(cond(ctx));
      if (isGridLike(c)) {
        const y = deref(yes(ctx));
        const n = deref(noBranch(ctx));
        return liftN([c, y, n], ([cv, yv, nv]) => {
          const b = toBoolean(cv);
          return b instanceof CellError ? b : b ? yv : nv;
        });
      }
      const b = toBoolean(c);
      if (b instanceof CellError) return b;
      return b ? yes(ctx) : noBranch(ctx);
    };
  }

  private ifErrorForm(name: string, argNodes: Node[], scope: Scope | null): Thunk {
    const bad = this.arity(name, argNodes, 2, 2);
    if (bad) return bad;
    const [value, alt] = argNodes.map((a) => this.compile(a, scope));
    const matches = name === 'IFNA' ? (e: CellError) => e.code === '#N/A' : () => true;
    return (ctx) => {
      const v = deref(value(ctx));
      if (isGridLike(v)) {
        const a = deref(alt(ctx));
        return liftN([v, a], ([x, y]) => (x instanceof CellError && matches(x) ? y : x));
      }
      return v instanceof CellError && matches(v) ? alt(ctx) : v;
    };
  }

  private ifsForm(argNodes: Node[], scope: Scope | null): Thunk {
    if (argNodes.length < 2 || argNodes.length % 2 !== 0) return this.arity('IFS', argNodes, -1, -1)!;
    const thunks = argNodes.map((a) => this.compile(a, scope));
    return (ctx) => {
      for (let i = 0; i < thunks.length; i += 2) {
        const b = toBoolean(deref(thunks[i](ctx)) as Scalar);
        if (b instanceof CellError) return b;
        if (b) return thunks[i + 1](ctx);
      }
      return Errors.na;
    };
  }

  private chooseForm(argNodes: Node[], scope: Scope | null): Thunk {
    const bad = this.arity('CHOOSE', argNodes, 2, 255);
    if (bad) return bad;
    const [index, ...options] = argNodes.map((a) => this.compile(a, scope));
    return (ctx) => {
      const i = deref(index(ctx));
      if (isGridLike(i)) return Errors.value;
      if (i instanceof CellError) return i;
      const k = Math.trunc(Number(i));
      if (!(k >= 1 && k <= options.length)) return Errors.value;
      return options[k - 1](ctx);
    };
  }

  private switchForm(argNodes: Node[], scope: Scope | null): Thunk {
    const bad = this.arity('SWITCH', argNodes, 3, 255);
    if (bad) return bad;
    const [expr, ...rest] = argNodes.map((a) => this.compile(a, scope));
    const hasDefault = rest.length % 2 === 1;
    return (ctx) => {
      const v = deref(expr(ctx));
      if (v instanceof CellError) return v;
      if (isGridLike(v)) return Errors.value;
      for (let i = 0; i + 1 < rest.length; i += 2) {
        const candidate = deref(rest[i](ctx));
        if (!isGridLike(candidate) && !(candidate instanceof CellError) && candidate === v)
          return rest[i + 1](ctx);
        if (
          typeof candidate === 'string' &&
          typeof v === 'string' &&
          candidate.toLowerCase() === v.toLowerCase()
        ) {
          return rest[i + 1](ctx);
        }
      }
      return hasDefault ? rest[rest.length - 1](ctx) : Errors.na;
    };
  }

  private letForm(argNodes: Node[], scope: Scope | null): Thunk {
    if (argNodes.length < 3 || argNodes.length % 2 === 0) {
      const err = new CellError('#VALUE!', 'LET expects name/value pairs followed by a calculation');
      return () => err;
    }
    const names: string[] = [];
    const frame = new Scope(names, scope);
    const values: Thunk[] = [];
    for (let i = 0; i + 1 < argNodes.length; i += 2) {
      const n = argNodes[i];
      if (n.kind !== 'name') {
        const err = new CellError('#NAME?', 'LET names must be identifiers');
        return () => err;
      }
      // Each binding sees the earlier ones, so compile it before adding its own name.
      values.push(this.compile(argNodes[i + 1], frame));
      names.push(n.name.toUpperCase());
    }
    const body = this.compile(argNodes[argNodes.length - 1], frame);
    const size = values.length;
    return (ctx) => {
      const env: Env = { vals: new Array(size), parent: ctx.env };
      const inner = withEnv(ctx, env);
      for (let i = 0; i < size; i++) env.vals[i] = values[i](inner);
      return body(inner);
    };
  }

  private lambdaForm(argNodes: Node[], scope: Scope | null): Thunk {
    if (argNodes.length < 1) {
      const err = new CellError('#VALUE!', 'LAMBDA needs a body');
      return () => err;
    }
    const params: string[] = [];
    for (const p of argNodes.slice(0, -1)) {
      if (p.kind !== 'name') {
        const err = new CellError('#VALUE!', 'LAMBDA parameters must be identifiers');
        return () => err;
      }
      params.push(p.name.toUpperCase());
    }
    const body = this.compile(argNodes[argNodes.length - 1], new Scope(params, scope));
    const arity = params.length;
    return (ctx) => new LambdaValue(arity, (args) => body(withEnv(ctx, { vals: args, parent: ctx.env })));
  }
}

/** Compiles an AST into a closure tree. `row`/`col` is the cell the formula was written in. */
export function compileFormula(node: Node, row: number, col: number): CompiledFormula {
  const c = new Compiler(row, col);
  const thunk = c.compile(node, null);
  return { thunk, deps: c.deps, names: [...c.names], volatile: c.volatile };
}

/** Converts an expression result into something storable in a cell (single value or array). */
export function toCellResult(v: Value): Scalar | ArrayValue | NumMatrix | RangeRef {
  if (v instanceof LambdaValue) return Errors.calc;
  if (isGrid(v)) {
    if (v.rows === 1 && v.cols === 1) {
      const s = v.get(0, 0);
      return s === null ? 0 : s;
    }
    return v;
  }
  return v === null ? 0 : v;
}
