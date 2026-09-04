// SPDX-License-Identifier: MPL-2.0

import { AsmModule } from './builder.ts';
import { gzipCodec } from './driver/codec/codec.ts';
import { jsEngine } from './driver/js/engine.ts';
import { isGlob, resolveGlob } from './driver/glob.ts';
import { SourceError, type SourceInfo } from './error.ts';
import { JS_MODULES, jsModuleNames } from './jsmodule/index.ts';
import type { FileCallbacks } from './libassembler.ts';
import type { JsActionTable, SymbolDefine } from './options.ts';
import { dirOf, joinDir } from './util.ts';

export interface JsPreprocessOptions {
  jsActions: JsActionTable;
  allowJavascript?: boolean;
  callbacks?: FileCallbacks;
  includePaths?: string[];
  binIncludePaths?: string[];
  /** `-D` values, exposed to a block as the `defines` binding. */
  defines?: SymbolDefine[];
}

export interface JsPreprocessResult {
  /** Source with blocks replaced by `.jsactions n` and declarations blanked. */
  code: string;
  /** Whether the file had any block or declaration at all. */
  usedJavascript: boolean;
  /** How many blocks ran, so the frontend can report where JS executed. */
  blocks: number;
}

/** One `.jsinput` binding: a file's path plus its contents both ways. */
export interface JsInputFile {
  path: string;
  bytes: Uint8Array;
  text: string;
}

// Intentionally looks for ones that start a line for a "poormans" comment handler
const RE_DIRECTIVE = /^\s*(\.[a-z_][a-z0-9_]*)\s*(.*?)\s*$/i;
const RE_INPUT_ARGS = /^([A-Za-z_$][\w$]*)\s*,\s*(.*)$/;
const RE_MODULE_NAME = /^[A-Za-z_$][\w$]*$/;

// Nesting that would make a declaration conditional or repeated.
const OPENERS = new Set([
  '.if', '.ifdef', '.ifndef', '.ifblank', '.ifnblank', '.ifconst',
  '.ifnconst', '.ifref', '.ifnref', '.ifp02', '.ifsym', '.ifnsym',
  '.macro', '.mac', '.proc', '.scope', '.repeat', '.rep',
  '.struct', '.union', '.enum',
]);

const CLOSERS = new Set([
  '.endif', '.endmacro', '.endmac', '.endproc', '.endscope',
  '.endrep', '.endrepeat', '.endstruct', '.endunion', '.endenum',
]);

const DECLARATIONS = new Set(['.jsinclude', '.jsinput', '.jsmodule']);

function fail(file: string, line: number, message: string): never {
  const source: SourceInfo = {file, line, column: 0};
  throw new SourceError(`${message}`, source);
}

/** Strips one layer of quotes from a `.jsinclude`/`.jsinput` argument. */
function unquote(file: string, line: number, arg: string): string {
  const m = /^"([^"]*)"$|^'([^']*)'$/.exec(arg);
  if (!m) fail(file, line, `Expected a quoted filename, got: ${arg}`);
  return m[1] ?? m[2];
}

function searchPaths(file: string, paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of [dirOf(file), ...paths]) {
    const key = joinDir('', p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** `.jsinclude` resolves exactly like `.include` does. */
function includeSearch(file: string, opts: JsPreprocessOptions): string[] {
  return searchPaths(file, opts.includePaths ?? ['./']);
}

/** `.jsinput` resolves exactly like `.incbin` does, `./` fallback included. */
function inputSearch(file: string, opts: JsPreprocessOptions): string[] {
  const paths = opts.binIncludePaths?.length ? opts.binIncludePaths :
      opts.includePaths?.length ? opts.includePaths : [];
  return searchPaths(file, [...paths, './']);
}

/** Maps `-D` values into the plain object a block sees, numbers where they parse. */
function definesScope(defines: readonly SymbolDefine[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const {name, value} of defines ?? []) {
    const num = Number(value);
    out[name] = value !== '' && Number.isFinite(num) ? num : value;
  }
  return out;
}

interface Declarations {
  includes: {path: string, line: number}[];
  inputs: {name: string, pattern: string, line: number}[];
  modules: {name: string, line: number}[];
}

interface Block {
  /** 1-based line of the `.jsbegin`. */
  start: number;
  /** 1-based line of the `.jsend`. */
  end: number;
  body: string;
}

/** Splits the file into declarations, blocks, and the lines that are neither. */
function scan(lines: readonly string[], file: string): {decls: Declarations, blocks: Block[]} {
  const decls: Declarations = {includes: [], inputs: [], modules: []};
  const blocks: Block[] = [];
  // Depth is used for a basic check to see if the `.jsinclude/jsinput` are inside `.if` blocks
  // which is likely an error.
  let depth = 0;
  let block: {start: number, body: string[]} | undefined;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const m = RE_DIRECTIVE.exec(lines[i]);
    const directive = m ? m[1].toLowerCase() : undefined;
    const rest = m ? m[2] : '';

    if (block) {
      if (directive === '.jsend') {
        blocks.push({start: block.start, end: lineNo, body: block.body.join('\n')});
        block = undefined;
      } else if (directive === '.jsbegin') {
        fail(file, lineNo, `.jsbegin inside a block that started on line ${block.start}`);
      } else {
        block.body.push(lines[i]);
      }
      continue;
    }

    if (!directive) continue;

    if (directive === '.jsend') fail(file, lineNo, `.jsend without a matching .jsbegin`);

    if (directive === '.jsbegin' || DECLARATIONS.has(directive)) {
      if (depth > 0 && DECLARATIONS.has(directive)) {
        fail(file, lineNo,
             `${directive} cannot appear inside .if/.macro/.proc/.repeat: ` +
             `it is resolved before any block runs, so it can never be conditional`);
      }
      if (directive === '.jsbegin') {
        block = {start: lineNo, body: []};
      } else if (directive === '.jsinclude') {
        decls.includes.push({path: unquote(file, lineNo, rest), line: lineNo});
      } else if (directive === '.jsmodule') {
        if (!RE_MODULE_NAME.test(rest)) {
          fail(file, lineNo, `Expected .jsmodule <name>, got: ${rest || '(nothing)'}`);
        }
        decls.modules.push({name: rest, line: lineNo});
      } else {
        const args = RE_INPUT_ARGS.exec(rest);
        if (!args) fail(file, lineNo, `Expected .jsinput <name>, "<path>"`);
        decls.inputs.push(
            {name: args[1], pattern: unquote(file, lineNo, args[2]), line: lineNo});
      }
      continue;
    }

    if (OPENERS.has(directive)) depth++;
    else if (CLOSERS.has(directive) && depth > 0) depth--;
  }

  if (block) fail(file, block.start, `.jsbegin without a matching .jsend`);
  return {decls, blocks};
}

function loadModules(file: string, decls: Declarations): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const {name, line} of decls.modules) {
    const text = JS_MODULES.get(name);
    if (text == null) {
      fail(file, line,
           `Unknown .jsmodule: ${name}\n` +
           `  Known modules: ${jsModuleNames().join(', ')}`);
    }
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(text);
  }
  return out;
}

// Expose the registered gzip codec as deflate to UPNG
function deflate(): ((data: Uint8Array, level?: number) => Uint8Array) | undefined {
  const codec = gzipCodec();
  return codec?.deflate ? (data, level) => codec.deflate!(data, level) : undefined;
}

function loadInclude(file: string, path: string, opts: JsPreprocessOptions): string {
  const found = opts.callbacks?.resolveText?.(includeSearch(file, opts), path);
  if (!found) fail(file, 1, `Could not find .jsinclude file: ${path}`);
  return found.content;
}

function loadInput(bases: readonly string[], path: string,
                   opts: JsPreprocessOptions): JsInputFile | undefined {
  const found = opts.callbacks?.resolveBinary?.(bases, path);
  if (!found) return undefined;
  const bytes = typeof found.content === 'string'
      ? new TextEncoder().encode(found.content) : found.content;
  return {path: joinDir(bases[found.baseIndex] ?? '', path), bytes,
          text: new TextDecoder().decode(bytes)};
}

function resolveInputs(file: string, decls: Declarations,
                       opts: JsPreprocessOptions): Record<string, unknown> {
  const scope: Record<string, unknown> = {};
  const bases = inputSearch(file, opts);
  for (const {name, pattern, line} of decls.inputs) {
    if (!opts.callbacks) fail(file, line, `.jsinput needs file callbacks: ${pattern}`);
    if (!isGlob(pattern)) {
      const loaded = loadInput(bases, pattern, opts);
      if (!loaded) fail(file, line, `Could not find .jsinput file: ${pattern}`);
      scope[name] = loaded;
      continue;
    }
    let matches;
    try {
      matches = resolveGlob(opts.callbacks, bases, pattern);
    } catch (err) {
      fail(file, line, `.jsinput ${(err as Error).message}`);
    }
    scope[name] = matches.map(m => {
      const loaded = loadInput([m.base], m.path, opts);
      if (!loaded) fail(file, line, `Could not read .jsinput file: ${joinDir(m.base, m.path)}`);
      return loaded;
    });
  }
  return scope;
}

/**
 * Used to blank out lines from the source file to keep the line number matching when removing the
 * .jsinclude/.jsinput lines.
 */
function blank(lines: string[], start: number, end: number, text = '') {
  lines[start - 1] = text;
  for (let i = start; i < end; i++) lines[i] = '';
}

export function jsPreprocess(code: string, file: string,
                             opts: JsPreprocessOptions): JsPreprocessResult {
  const lines = code.split('\n');
  const {decls, blocks} = scan(lines, file);
  if (!blocks.length && !decls.includes.length && !decls.inputs.length &&
      !decls.modules.length) {
    return {code, usedJavascript: false, blocks: 0};
  }
  if (!opts.allowJavascript) {
    const first = [...blocks.map(b => ({line: b.start, what: '.jsbegin'})),
                   ...decls.includes.map(d => ({line: d.line, what: '.jsinclude'})),
                   ...decls.inputs.map(d => ({line: d.line, what: '.jsinput'})),
                   ...decls.modules.map(d => ({line: d.line, what: '.jsmodule'}))]
        .sort((x, y) => x.line - y.line)[0];
    fail(file, first.line,
         `${first.what} requires --allow-javascript\n` +
         `  JavaScript blocks execute arbitrary code at build time and are` +
         ` disabled by default.`);
  }

  const engine = jsEngine();
  if (!engine) {
    fail(file, blocks.length ? blocks[0].start : 1,
         `This frontend has no JavaScript engine, so .jsbegin blocks cannot run`);
  }

  const prelude = [...loadModules(file, decls),
                   ...decls.includes.map(d => loadInclude(file, d.path, opts))].join('\n');
  const inputs = resolveInputs(file, decls, opts);
  const defines = definesScope(opts.defines);

  const out = [...lines];
  const jsDeflate = deflate();
  for (const b of blocks) {
    const a = new AsmModule(file, {file, line: b.start});
    try {
      engine.run(`${prelude}\n${b.body}`, {a, defines, __js65_deflate: jsDeflate, ...inputs});
    } catch (err) {
      fail(file, b.start, `JavaScript block failed: ${(err as Error).message}`);
    }
    blank(out, b.start, b.end, `.jsactions ${opts.jsActions.add(a.actions)}`);
  }
  for (const {line} of decls.inputs) blank(out, line, line);
  for (const {line} of decls.modules) blank(out, line, line);
  for (let i = 0; i < lines.length; i++) {
    const m = RE_DIRECTIVE.exec(lines[i]);
    if (m && m[1].toLowerCase() === '.jsinclude') out[i] = '';
  }

  return {code: out.join('\n'), usedJavascript: true, blocks: blocks.length};
}
