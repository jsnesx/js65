
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

/*
 * Custom validators for untrusted JSON inputs the assembler takes
 * (ie: *.o module files and actionLists)
 * 
 * Its a bit painful to need to update these structures too, but at
 * least we don't need to depend on zod anymore.
 */

import { Base64 } from './base64.ts';
import type { Chunk, Module, OverwriteMode, Segment, Substitution, Symbol } from './module.ts';
import type { Expr, Meta } from './expr.ts';
import type { SourceInfo } from './token.ts';
import type { ActionSource, AssemblyAction, AssemblyInput, Js65Options, Js65Request, OutputFormat } from './libassembler.ts';

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

// A thrown sentinel carrying a path-qualified message; caught at the top of each
// public entry point and converted into a `{ ok: false }` result. Using a throw
// internally keeps the recursive validators readable without threading results
// through every call.
class ValidationError extends Error {}

function fail(path: string, msg: string): never {
  throw new ValidationError(`${path}: ${msg}`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function reqNumber(v: unknown, path: string): number {
  if (typeof v !== 'number' || Number.isNaN(v)) fail(path, 'expected number');
  return v;
}
function reqString(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'expected string');
  return v;
}
function optNumber(v: unknown, path: string): number | undefined {
  return v === undefined ? undefined : reqNumber(v, path);
}
function optString(v: unknown, path: string): string | undefined {
  return v === undefined ? undefined : reqString(v, path);
}
function optBoolean(v: unknown, path: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'boolean') fail(path, 'expected boolean');
  return v;
}
function reqArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'expected array');
  return v;
}

// SourceInfo and Exprs are recursive types, so keep that in mind when reading this
function validateSourceInfo(v: unknown, path: string): SourceInfo {
  if (!isObject(v)) fail(path, 'expected object');
  const out: SourceInfo = {
    file: reqString(v.file, `${path}.file`),
    line: reqNumber(v.line, `${path}.line`),
    column: reqNumber(v.column, `${path}.column`),
  };
  const ident = optString(v.ident, `${path}.ident`);
  if (ident !== undefined) out.ident = ident;
  if (v.parent !== undefined) out.parent = validateSourceInfo(v.parent, `${path}.parent`);
  return out;
}

function validateMeta(v: unknown, path: string): Meta {
  if (!isObject(v)) fail(path, 'expected object');
  const out: Meta = {};
  const rel = optBoolean(v.rel, `${path}.rel`);
  if (rel !== undefined) out.rel = rel;
  const chunk = optNumber(v.chunk, `${path}.chunk`);
  if (chunk !== undefined) out.chunk = chunk;
  const org = optNumber(v.org, `${path}.org`);
  if (org !== undefined) out.org = org;
  const bank = optNumber(v.bank, `${path}.bank`);
  if (bank !== undefined) out.bank = bank;
  const offset = optNumber(v.offset, `${path}.offset`);
  if (offset !== undefined) out.offset = offset;
  const size = optNumber(v.size, `${path}.size`);
  if (size !== undefined) out.size = size;
  const branch = optBoolean(v.branch, `${path}.branch`);
  if (branch !== undefined) out.branch = branch;
  return out;
}

function validateExpr(v: unknown, path: string): Expr {
  if (!isObject(v)) fail(path, 'expected object');
  const out: Expr = { op: reqString(v.op, `${path}.op`) };
  const num = optNumber(v.num, `${path}.num`);
  if (num !== undefined) out.num = num;
  const str = optString(v.str, `${path}.str`);
  if (str !== undefined) out.str = str;
  const sym = optString(v.sym, `${path}.sym`);
  if (sym !== undefined) out.sym = sym;
  if (v.meta !== undefined) out.meta = validateMeta(v.meta, `${path}.meta`);
  if (v.source !== undefined) out.source = validateSourceInfo(v.source, `${path}.source`);
  if (v.args !== undefined) {
    const arr = reqArray(v.args, `${path}.args`);
    out.args = arr.map((e, i) => validateExpr(e, `${path}.args[${i}]`));
  }
  return out;
}

function validateSubstitution(v: unknown, path: string): Substitution {
  if (!isObject(v)) fail(path, 'expected object');
  return {
    offset: reqNumber(v.offset, `${path}.offset`),
    size: reqNumber(v.size, `${path}.size`),
    expr: validateExpr(v.expr, `${path}.expr`),
  };
}

function validateSymbol(v: unknown, path: string): Symbol {
  if (!isObject(v)) fail(path, 'expected object');
  const out: Symbol = {};
  const exp = optString(v.export, `${path}.export`);
  if (exp !== undefined) out.export = exp;
  if (v.expr !== undefined) out.expr = validateExpr(v.expr, `${path}.expr`);
  return out;
}

const OVERWRITE_MODES = new Set<string>(['forbid', 'allow', 'require']);

function validateChunk(v: unknown, path: string): Chunk {
  if (!isObject(v)) fail(path, 'expected object');

  // data is converted from base64 string -> Uint8Array
  if (typeof v.data !== 'string') fail(`${path}.data`, 'expected base64 string');
  let data: Uint8Array;
  try {
    data = new Base64().decode(v.data);
  } catch {
    fail(`${path}.data`, 'invalid base64');
  }

  const segments = reqArray(v.segments, `${path}.segments`)
    .map((s, i) => reqString(s, `${path}.segments[${i}]`));

  const out: Chunk = { segments, data };

  const name = optString(v.name, `${path}.name`);
  if (name !== undefined) out.name = name;
  const org = optNumber(v.org, `${path}.org`);
  if (org !== undefined) out.org = org;
  if (v.subs !== undefined) {
    out.subs = reqArray(v.subs, `${path}.subs`)
      .map((s, i) => validateSubstitution(s, `${path}.subs[${i}]`));
  }
  if (v.asserts !== undefined) {
    out.asserts = reqArray(v.asserts, `${path}.asserts`)
      .map((e, i) => validateExpr(e, `${path}.asserts[${i}]`));
  }
  if (v.overwrite !== undefined) {
    const ow = reqString(v.overwrite, `${path}.overwrite`);
    if (!OVERWRITE_MODES.has(ow)) fail(`${path}.overwrite`, `expected one of forbid|allow|require`);
    out.overwrite = ow as OverwriteMode;
  }
  // sourceMap / labelIndex are `Map`s that do not survive JSON serialization
  // (JSON.stringify emits `{}`), so they are effectively never present in a
  // serialized `.o` file. 
  // Accept only a real Map with correctly-typed entries and reject anything else.
  if (v.sourceMap !== undefined) {
    if (!(v.sourceMap instanceof Map)) fail(`${path}.sourceMap`, 'expected Map');
    const m = new Map<number, SourceInfo>();
    for (const [k, val] of v.sourceMap as Map<unknown, unknown>) {
      m.set(reqNumber(k, `${path}.sourceMap.key`), validateSourceInfo(val, `${path}.sourceMap.value`));
    }
    out.sourceMap = m;
  }
  if (v.labelIndex !== undefined) {
    if (!(v.labelIndex instanceof Map)) fail(`${path}.labelIndex`, 'expected Map');
    const m = new Map<string, number>();
    for (const [k, val] of v.labelIndex as Map<unknown, unknown>) {
      m.set(reqString(k, `${path}.labelIndex.key`), reqNumber(val, `${path}.labelIndex.value`));
    }
    out.labelIndex = m;
  }
  return out;
}

function validateSegment(v: unknown, path: string): Segment {
  if (!isObject(v)) fail(path, 'expected object');
  const out: Segment = { name: reqString(v.name, `${path}.name`) };
  const bank = optNumber(v.bank, `${path}.bank`);
  if (bank !== undefined) out.bank = bank;
  const size = optNumber(v.size, `${path}.size`);
  if (size !== undefined) out.size = size;
  const offset = optNumber(v.offset, `${path}.offset`);
  if (offset !== undefined) out.offset = offset;
  const memory = optNumber(v.memory, `${path}.memory`);
  if (memory !== undefined) out.memory = memory;
  const addressing = optNumber(v.addressing, `${path}.addressing`);
  if (addressing !== undefined) out.addressing = addressing;
  const fill = optNumber(v.fill, `${path}.fill`);
  if (fill !== undefined) out.fill = fill;
  const o = optString(v.out, `${path}.out`);
  if (o !== undefined) out.out = o;
  const overlay = optString(v.overlay, `${path}.overlay`);
  if (overlay !== undefined) out.overlay = overlay;
  const def = optBoolean(v.default, `${path}.default`);
  if (def !== undefined) out.default = def;
  if (v.free !== undefined) {
    out.free = reqArray(v.free, `${path}.free`).map((row, i) => {
      const r = reqArray(row, `${path}.free[${i}]`);
      return r.map((n, j) => reqNumber(n, `${path}.free[${i}][${j}]`));
    });
  }
  return out;
}

/**
 * Validate a parsed-JSON object as a serialized Module (`.o` file).
 */
export function parseModule(obj: unknown): Validated<Module> {
  try {
    if (!isObject(obj)) fail('module', 'expected object');
    const out: Module = {};
    const name = optString(obj.name, 'module.name');
    if (name !== undefined) out.name = name;
    if (obj.chunks !== undefined) {
      out.chunks = reqArray(obj.chunks, 'module.chunks')
        .map((c, i) => validateChunk(c, `module.chunks[${i}]`));
    }
    if (obj.symbols !== undefined) {
      out.symbols = reqArray(obj.symbols, 'module.symbols')
        .map((s, i) => validateSymbol(s, `module.symbols[${i}]`));
    }
    if (obj.segments !== undefined) {
      out.segments = reqArray(obj.segments, 'module.segments')
        .map((s, i) => validateSegment(s, `module.segments[${i}]`));
    }
    if (obj.debugSymbols !== undefined) {
      out.debugSymbols = reqArray(obj.debugSymbols, 'module.debugSymbols')
        .map((s, i) => validateSymbol(s, `module.debugSymbols[${i}]`));
    }
    return { ok: true, value: out };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: err.message };
    throw err;
  }
}

function validateActionSource(v: unknown, path: string): ActionSource {
  if (!isObject(v)) fail(path, 'expected object');
  return {
    file: reqString(v.file, `${path}.file`),
    line: reqNumber(v.line, `${path}.line`),
  };
}

// `bytes`/`words` arrive either as a Uint8Array (a JSON reviver already decoded
// a base64 string) or as a literal array of numbers / `{op:'sym', sym}` references.
function validateByteList(v: unknown, path: string): Array<number | { op: 'sym'; sym: string }> {
  if (v instanceof Uint8Array) return Array.from(v);
  const arr = reqArray(v, path);
  return arr.map((e, i) => {
    if (typeof e === 'number') return e;
    if (isObject(e) && e.op === 'sym') {
      return { op: 'sym' as const, sym: reqString(e.sym, `${path}[${i}].sym`) };
    }
    fail(`${path}[${i}]`, 'expected number or {op:"sym",sym}');
  });
}

function validateAction(v: unknown, path: string): AssemblyAction {
  if (!isObject(v)) fail(path, 'expected object');
  const action = reqString(v.action, `${path}.action`);
  const source = v.source === undefined ? undefined : validateActionSource(v.source, `${path}.source`);
  const withSource = <T extends object>(o: T): T => (source ? { ...o, source } : o);

  switch (action) {
    case 'code':
      return withSource({
        action: 'code' as const,
        code: reqString(v.code, `${path}.code`),
        ...(v.name !== undefined ? { name: reqString(v.name, `${path}.name`) } : {}),
      });
    case 'label':
      return withSource({ action: 'label' as const, label: reqString(v.label, `${path}.label`) });
    case 'byte':
      return withSource({ action: 'byte' as const, bytes: validateByteList(v.bytes, `${path}.bytes`) });
    case 'word':
      return withSource({ action: 'word' as const, words: validateByteList(v.words, `${path}.words`) });
    case 'org':
      return withSource({
        action: 'org' as const,
        addr: reqNumber(v.addr, `${path}.addr`),
        ...(v.name !== undefined ? { name: reqString(v.name, `${path}.name`) } : {}),
      });
    case 'segment': {
      const name = Array.isArray(v.name)
        ? v.name.map((n, i) => reqString(n, `${path}.name[${i}]`))
        : reqString(v.name, `${path}.name`);
      return withSource({ action: 'segment' as const, name });
    }
    case 'reloc':
      return withSource({
        action: 'reloc' as const,
        ...(v.name !== undefined ? { name: reqString(v.name, `${path}.name`) } : {}),
      });
    case 'export':
      return withSource({ action: 'export' as const, name: reqString(v.name, `${path}.name`) });
    case 'assign':
    case 'set': {
      if (typeof v.value !== 'number' && typeof v.value !== 'string') {
        fail(`${path}.value`, 'expected number or string');
      }
      return withSource({
        action: action as 'assign' | 'set',
        name: reqString(v.name, `${path}.name`),
        value: v.value as number | string,
      });
    }
    case 'free':
      return withSource({ action: 'free' as const, size: reqNumber(v.size, `${path}.size`) });
    default:
      fail(`${path}.action`, `unknown action "${action}"`);
  }
}

/**
 * Validate a parsed-JSON object as `AssemblyAction[][]` (the programmatic
 * action lists fed by integration libraries).
 */
export function parseActionModules(obj: unknown): Validated<AssemblyAction[][]> {
  try {
    const modules = reqArray(obj, 'modules');
    const value = modules.map((mod, i) => {
      const actions = reqArray(mod, `modules[${i}]`);
      return actions.map((a, j) => validateAction(a, `modules[${i}][${j}]`));
    });
    return { ok: true, value };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: err.message };
    throw err;
  }
}

function validateInput(v: unknown, path: string): AssemblyInput {
  if (!isObject(v)) fail(path, 'expected object');
  const type = reqString(v.type, `${path}.type`);
  switch (type) {
    case 'source':
      return {
        type: 'source',
        code: reqString(v.code, `${path}.code`),
        name: reqString(v.name, `${path}.name`),
      };
    case 'module': {
      const mod = parseModule(v.module);
      if (!mod.ok) fail(`${path}.module`, mod.error);
      return { type: 'module', module: mod.value };
    }
    case 'actions': {
      const actions = reqArray(v.actions, `${path}.actions`)
        .map((a, i) => validateAction(a, `${path}.actions[${i}]`));
      const name = optString(v.name, `${path}.name`);
      return name !== undefined ? { type: 'actions', actions, name } : { type: 'actions', actions };
    }
    default:
      fail(`${path}.type`, `unknown input type "${type}"`);
  }
}

/**
 * Validate a parsed-JSON array as `AssemblyInput[]` to make sure each action is fine
 */
export function parseInputs(arr: unknown): AssemblyInput[] {
  const inputs = reqArray(arr, 'inputs');
  return inputs.map((v, i) => validateInput(v, `inputs[${i}]`));
}

const OUTPUT_FORMATS = new Set<string>(['binary', 'ips', 'object']);

function validateOptions(v: unknown, path: string): Js65Options {
  if (v === undefined) return {};
  if (!isObject(v)) fail(path, 'expected object');
  const out: Js65Options = {};
  if (v.includePaths !== undefined) {
    out.includePaths = reqArray(v.includePaths, `${path}.includePaths`)
      .map((s, i) => reqString(s, `${path}.includePaths[${i}]`));
  }
  const lineContinuations = optBoolean(v.lineContinuations, `${path}.lineContinuations`);
  if (lineContinuations !== undefined) out.lineContinuations = lineContinuations;
  const numberSeparators = optBoolean(v.numberSeparators, `${path}.numberSeparators`);
  if (numberSeparators !== undefined) out.numberSeparators = numberSeparators;
  const generateDebugInfo = optBoolean(v.generateDebugInfo, `${path}.generateDebugInfo`);
  if (generateDebugInfo !== undefined) out.generateDebugInfo = generateDebugInfo;
  const debugLevel = optNumber(v.debugLevel, `${path}.debugLevel`);
  if (debugLevel !== undefined) out.debugLevel = debugLevel;
  const target = optString(v.target, `${path}.target`);
  if (target !== undefined) out.target = target;
  const baseRomOffset = optNumber(v.baseRomOffset, `${path}.baseRomOffset`);
  if (baseRomOffset !== undefined) out.baseRomOffset = baseRomOffset;
  if (v.outputFormat !== undefined) {
    const fmt = reqString(v.outputFormat, `${path}.outputFormat`);
    if (!OUTPUT_FORMATS.has(fmt)) fail(`${path}.outputFormat`, 'expected one of binary|ips|object');
    out.outputFormat = fmt as OutputFormat;
  }
  return out;
}

export function parseRequest(obj: unknown): Validated<Js65Request> {
  try {
    if (!isObject(obj)) fail('request', 'expected object');
    const inputs = parseInputs(obj.inputs);
    const options = validateOptions(obj.options, 'request.options');
    return { ok: true, value: { inputs, options } };
  } catch (err) {
    if (err instanceof ValidationError) return { ok: false, error: err.message };
    throw err;
  }
}
