// SPDX-License-Identifier: MPL-2.0

import { AsmModule } from './builder.ts';
import { gzipCodec } from './driver/codec/codec.ts';
import { getJsFrames, jsEngine, type JsFrame } from './driver/js/engine.ts';
import { isGlob, resolveGlob } from './driver/glob.ts';
import { SourceError, type SourceInfo } from './error.ts';
import { JS_MODULES, jsModuleMap, jsModuleNames } from './jsmodule/index.ts';
import { mapPosition } from './jsmodule/sourcemap.ts';
import type { FileCallbacks } from './libassembler.ts';
import type { MesenLabelFormat } from './linker.ts';
import type { JsPost, RomPatch, RomPatchRun } from './module.ts';
import type { JsActionTable, JsBlockContext } from './options.ts';
import { dirOf, joinDir } from './util.ts';

export interface JsPreprocessOptions {
  jsActions: JsActionTable;
  allowJavascript?: boolean;
  callbacks?: FileCallbacks;
  includePaths?: string[];
  binIncludePaths?: string[];
  baseRom?: Uint8Array;
}

export interface JsPreprocessResult {
  /** Source with blocks replaced by `.jsaction n` and declarations blanked. */
  code: string;
  /** Whether the file had any block or declaration at all. */
  usedJavascript: boolean;
  /** How many blocks were compiled, so the frontend can report where JS lives. */
  blocks: number;
  /**
   * Diffs the file's `baserom` against the base once its blocks have run.
   * Undefined when the file has no JavaScript.
   */
  romPatch?: () => RomPatch | undefined;
  /** `.jspostbegin` blocks to store in the module for the linker to run. */
  jsPost?: JsPost;
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

function definesView(ctx: JsBlockContext): Record<string, number | undefined> {
  return new Proxy({}, {
    get: (_target, prop) => typeof prop === 'string' ? ctx.symbol(prop) : undefined,
    has: (_target, prop) => typeof prop === 'string' && ctx.symbol(prop) !== undefined,
  });
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

const BLOCK_ENDS = new Set(['.jsend', '.jspostend']);

/** Splits the file into declarations, blocks, and the lines that are neither. */
function scan(lines: readonly string[], file: string):
    {decls: Declarations, blocks: Block[], posts: Block[]} {
  const decls: Declarations = {includes: [], inputs: [], modules: []};
  const blocks: Block[] = [];
  const posts: Block[] = [];
  // Depth is used for a basic check to see if the `.jsinclude/jsinput` are inside `.if` blocks
  // which is likely an error.
  let depth = 0;
  let block: {start: number, body: string[], post: boolean} | undefined;

  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const m = RE_DIRECTIVE.exec(lines[i]);
    const directive = m ? m[1].toLowerCase() : undefined;
    const rest = m ? m[2] : '';

    if (block) {
      const end = block.post ? '.jspostend' : '.jsend';
      if (directive === end) {
        (block.post ? posts : blocks).push(
            {start: block.start, end: lineNo, body: block.body.join('\n')});
        block = undefined;
      } else if (directive === '.jsbegin' || directive === '.jspostbegin') {
        fail(file, lineNo, `${directive} inside a block that started on line ${block.start}`);
      } else if (directive && BLOCK_ENDS.has(directive)) {
        fail(file, lineNo, `${directive} closing a block that needs ${end}`);
      } else {
        block.body.push(lines[i]);
      }
      continue;
    }

    if (!directive) continue;

    if (directive === '.jsend') fail(file, lineNo, `.jsend without a matching .jsbegin`);
    if (directive === '.jspostend') {
      fail(file, lineNo, `.jspostend without a matching .jspostbegin`);
    }
    if (directive === '.jspostbegin') {
      if (depth > 0) {
        fail(file, lineNo,
             `.jspostbegin cannot appear inside .if/.macro/.proc/.repeat: ` +
             `it runs once at link time, so it can never be conditional`);
      }
      block = {start: lineNo, body: [], post: true};
      continue;
    }

    if (directive === '.jsbegin' || DECLARATIONS.has(directive)) {
      if (depth > 0 && DECLARATIONS.has(directive)) {
        fail(file, lineNo,
             `${directive} cannot appear inside .if/.macro/.proc/.repeat: ` +
             `it is resolved before any block runs, so it can never be conditional`);
      }
      if (directive === '.jsbegin') {
        block = {start: lineNo, body: [], post: false};
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
        // Inputs spread last into the block scope, so this would silently win
        if (args[1] === 'baserom') fail(file, lineNo, `.jsinput cannot be named baserom`);
        decls.inputs.push(
            {name: args[1], pattern: unquote(file, lineNo, args[2]), line: lineNo});
      }
      continue;
    }

    if (OPENERS.has(directive)) depth++;
    else if (CLOSERS.has(directive) && depth > 0) depth--;
  }

  if (block) {
    fail(file, block.start, block.post ? `.jspostbegin without a matching .jspostend`
                                       : `.jsbegin without a matching .jsend`);
  }
  return {decls, blocks, posts};
}

/** Starts a code block that we use to map back to the original source for error reporting */
interface JsSegment {
  text: string;
  file: string;
  firstLine: number;
  /** Module name when `file` isnt a on disk file (for jsmodule) */
  module?: string;
}

function loadModules(file: string, decls: Declarations): JsSegment[] {
  const out: JsSegment[] = [];
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
    out.push({text, file: `<jsmodule ${name}>`, firstLine: 1, module: name});
  }
  return out;
}

// Expose the registered gzip codec as deflate to UPNG
function deflate(): ((data: Uint8Array, level?: number) => Uint8Array) | undefined {
  const codec = gzipCodec();
  return codec?.deflate ? (data, level) => codec.deflate!(data, level) : undefined;
}

function loadInclude(file: string, path: string, opts: JsPreprocessOptions): JsSegment {
  const bases = includeSearch(file, opts);
  const found = opts.callbacks?.resolveText?.(bases, path);
  if (!found) fail(file, 1, `Could not find .jsinclude file: ${path}`);
  return {text: found.content, file: joinDir(bases[found.baseIndex] ?? '', path),
          firstLine: 1};
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

/** Space is reserved not committed until used, so this isn't affecting ram usage by default */
const BASEROM_MAX_LENGTH = 32 * 1024 * 1024; // 32 MB

/** A copy of `base` in a resizable buffer, so blocks can grow it in place. */
function growableRom(base: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(base.length, {
    maxByteLength: Math.max(BASEROM_MAX_LENGTH, base.length),
  });
  const rom = new Uint8Array(buffer);
  rom.set(base);
  return rom;
}

export function diffRom(base: Uint8Array, rom: Uint8Array<ArrayBuffer>): RomPatch | undefined {
  if (rom.buffer.detached) {
    throw new Error('baserom buffer was detached (transfer() is not allowed)');
  }
  const newLength = rom.length;
  // The link-time merge keeps the largest length, so a shrink could never apply
  if (newLength < base.length) {
    throw new Error(`baserom was shrunk from ${base.length} to ${newLength} bytes; the ROM can only grow`);
  }
  const runs: RomPatchRun[] = [];
  let i = 0;
  while (i < newLength) {
    if (rom[i] === (base[i] ?? 0)) { i++; continue; }
    const start = i;
    while (i < newLength && rom[i] !== (base[i] ?? 0)) i++;
    // slice, not subarray: the run must not alias the live buffer
    runs.push({ offset: start, data: rom.slice(start, i) });
  }
  if (!runs.length && newLength === base.length) return undefined;
  return { newLength, runs };
}

/** Where a segment lands in the combined code, ordered by `start`. */
interface Span {
  start: number;
  segment: JsSegment;
}

function lineCount(text: string): number {
  return text.split('\n').length;
}

function combine(prelude: readonly JsSegment[], body: JsSegment): {code: string, spans: Span[]} {
  const spans: Span[] = [];
  let start = 1;
  for (const segment of prelude) {
    spans.push({start, segment});
    start += lineCount(segment.text);
  }
  const text = prelude.map(s => s.text).join('\n');
  // An empty prelude still costs the line the join below adds.
  spans.push({start: lineCount(text) + 1, segment: body});
  return {code: `${text}\n${body.text}`, spans};
}
// project - user included file
// module - jsmodule WITH a sourceMap
// unplaceable - jsmodule WITHOUT a sourceMap
type Placement = 'project' | 'module' | 'unplaceable';

/** Turns an engine line/column into the file position it came from. */
function locate(spans: readonly Span[], frame: JsFrame): {source: SourceInfo, kind: Placement} {
  let span = spans[0];
  for (const s of spans) {
    if (s.start <= frame.line) span = s;
  }
  const segment = span.segment;
  const line = segment.firstLine + (frame.line - span.start);
  const column = Math.max(0, frame.column - 1);
  const here = {file: segment.file, line, column};
  if (segment.module == null) return {source: here, kind: 'project'};
  // The bundle starts on line 2 of the module text, so the map's own numbering
  // is one line back. See `generated` in gen-jsmodules.ts.
  const mapped = mapPosition(jsModuleMap(segment.module), line - 1, column);
  if (!mapped) return {source: here, kind: 'unplaceable'};
  return {source: {file: `${segment.file}/${mapped.source}`,
                   line: mapped.line, column: mapped.column},
          kind: 'module'};
}

/**
 * Create the actual stack trace for the error starting with the `.jsbegin` block
 * and adding in each of the javascript stacks to it.
 */
function blockError(err: unknown, file: string, start: number,
                    spans: readonly Span[]): SourceError {
  const message = `JavaScript block failed: ${
      err instanceof Error ? err.message : String(err)}`;
  const frames = getJsFrames(err) ?? [];
  const located = frames.map(f => locate(spans, f));
  // drop frames without a source mapping
  const placed = located.filter(l => l.kind !== 'unplaceable');
  const head = placed.findIndex(l => l.kind === 'project');
  const rest = placed.filter((_, i) => i !== head);
  let source: SourceInfo | undefined =
      head >= 0 ? {file, line: start, column: 0} : undefined;
  // Outermost first, so the innermost frame ends up nearest the head.
  for (let i = rest.length - 1; i >= 0; i--) {
    source = {...rest[i].source, parent: source};
  }
  const out = new SourceError(message, head >= 0
      ? {...placed[head].source, parent: source}
      : {file, line: start, column: 0, parent: source});
  if (located.length) {
    out.stack = [`${out.name}: ${message}`,
                 ...located.map(({source: s}, i) =>
                     `    at ${frames[i].name ?? '<anonymous>'} (` +
                     `${s.file}:${s.line}:${s.column + 1})`)].join('\n');
  } else if (err instanceof Error && err.stack) {
    out.stack = err.stack;
  }
  return out;
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
  const {decls, blocks, posts} = scan(lines, file);
  if (!blocks.length && !posts.length && !decls.includes.length && !decls.inputs.length &&
      !decls.modules.length) {
    return {code, usedJavascript: false, blocks: 0};
  }
  if (!opts.allowJavascript) {
    const first = [...blocks.map(b => ({line: b.start, what: '.jsbegin'})),
                   ...posts.map(b => ({line: b.start, what: '.jspostbegin'})),
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
                   ...decls.includes.map(d => loadInclude(file, d.path, opts))];
  const inputs = resolveInputs(file, decls, opts);

  const out = [...lines];
  const jsDeflate = deflate();
  const base = opts.baseRom ?? new Uint8Array(0);
  const baserom = growableRom(base);
  for (const b of blocks) {
    // The body starts on the line after `.jsbegin`.
    const {code: src, spans} =
        combine(prelude, {text: b.body, file, firstLine: b.start + 1});
    const index = opts.jsActions.add(ctx => {
      const a = new AsmModule(file, {file, line: b.start});
      try {
        engine.run(src, {a, defines: definesView(ctx), baserom,
                         __js65_deflate: jsDeflate, ...inputs});
      } catch (err) {
        throw blockError(err, file, b.start, spans);
      }
      return a.actions;
    });
    blank(out, b.start, b.end, `.jsaction ${index}`);
  }
  for (const p of posts) blank(out, p.start, p.end);
  for (const {line} of decls.inputs) blank(out, line, line);
  for (const {line} of decls.modules) blank(out, line, line);
  for (let i = 0; i < lines.length; i++) {
    const m = RE_DIRECTIVE.exec(lines[i]);
    if (m && m[1].toLowerCase() === '.jsinclude') out[i] = '';
  }

  const romPatch = () => {
    try {
      return diffRom(base, baserom);
    } catch (err) {
      fail(file, blocks[0]?.start ?? 1, (err as Error).message);
    }
  };
  const jsPost: JsPost | undefined = posts.length ? {
    file,
    prelude: prelude.map(({text, ...s}) => s.module != null ? s : {...s, text}),
    blocks: posts.map(p => ({line: p.start, body: p.body})),
  } : undefined;
  return {code: out.join('\n'), usedJavascript: true, blocks: blocks.length, romPatch, jsPost};
}

/**
 * Runs every module's `.jspostbegin` blocks against a copy of the final ROM.
 * Blocks see the ROM as `rom`, which they may resize, and the debug labels as `labelMap`.
 */
export function jsPostprocess(posts: readonly JsPost[], image: Uint8Array,
                              labelMap: ReadonlyMap<string, MesenLabelFormat>): Uint8Array<ArrayBuffer> {
  const engine = jsEngine();
  if (!engine) {
    fail(posts[0].file, posts[0].blocks[0].line,
         `This frontend has no JavaScript engine, so .jspostbegin blocks cannot run`);
  }
  const jsDeflate = deflate();
  const rom = growableRom(image);
  for (const post of posts) {
    const prelude = post.prelude.map((s): JsSegment => {
      if (s.module == null) return {...s, text: s.text ?? ''};
      const text = JS_MODULES.get(s.module);
      if (text == null) {
        fail(post.file, post.blocks[0].line,
             `Unknown .jsmodule: ${s.module}\n  Known modules: ${jsModuleNames().join(', ')}`);
      }
      return {...s, text};
    });
    for (const b of post.blocks) {
      const {code, spans} = combine(prelude, {text: b.body, file: post.file, firstLine: b.line + 1});
      try {
        engine.run(code, {rom, labelMap, __js65_deflate: jsDeflate});
      } catch (err) {
        throw blockError(err, post.file, b.line, spans);
      }
      if (rom.buffer.detached) {
        fail(post.file, b.line, 'rom buffer was detached (transfer() is not allowed)');
      }
    }
  }
  // Hand back a plain buffer, since not every consumer copes with a resizable one
  return rom.slice();
}
