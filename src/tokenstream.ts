
// SPDX-License-Identifier: MPL-2.0

import { Base64 } from './base64.ts'
import {type Token} from './token.ts'
import {Tokenizer, type Options} from './tokenizer.ts'
import {type ErrorCollector} from './error.ts';
import {dirOf, joinDir} from './util.ts';
import * as Tokens from './token.ts';
// TODO: import raw text files seems painful right now.
import * as Common from './macpack/common.ts'
import * as Generic from './macpack/generic.ts'
import * as Longbranch from './macpack/longbranch.ts'
import * as Nes2header from './macpack/nes2header.ts'

// A frame is a token source, a pushback queue, and the directory that
// `.include`/`.incbin` inside this file should resolve relative to.
type Frame = {
  source?: Tokens.Source,
  queue: Token[][],
  dir?: string
};

// Arbitrarily chosen max stack depth for frames. Could bump it if people actually
// ran into this in practice. Just want it high enough to not cause real problems
// but low enough to catch issues quickly.
const MAX_DEPTH = 256;

/**
 * Build the directory list a `.include`/`.incbin` is searched in.
 * The first location to search is always the current directory,
 * then we search any -I directories. All of these are normalized to
 * POSIX style paths and deduplicated.
 */
function searchList(dir: string | undefined, paths: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of dir != null ? [dir, ...paths] : paths) {
    const key = joinDir('', p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

const MACPACK: Map<string, string> = new Map(
  [
    ['common', Common.text],
    ['generic', Generic.text],
    ['longbranch', Longbranch.text],
    ['nes2header', Nes2header.text],
  ]
);

/**
 * A file located by searching the include directories: which base it was found under,
 * plus its contents. The base is reported as an index into the `bases` array that was
 * passed in, since the caller already has those strings and an out-of-range index is a
 * detectable error where an arbitrary string is not. It is kept at all because two
 * `header.inc` files in different directories must resolve to distinct paths,
 * especially for debugging info.
 */
export interface ResolvedFile<T> {
  baseIndex: number;
  content: T;
}

/**
 * Searches `bases` in order for `filename` and reads the first hit, returning
 * `undefined` when no base has it.
 */
export interface ResolveFileCallback {
  (bases: readonly string[], filename: string): ResolvedFile<string> | undefined;
}
export interface ResolveFileBinaryCallback {
  (bases: readonly string[], filename: string): ResolvedFile<Uint8Array|string> | undefined;
}

export class SourceContents {
  data: Map<string, string> = new Map<string, string>();
}

export class TokenStream implements Tokens.Source {
  private stack: Frame[] = [];

  constructor(
    readonly resolveFile?: ResolveFileCallback,
    readonly resolveFileBinary?: ResolveFileBinaryCallback,
    readonly opts?: Options,
    readonly sourceContents?: SourceContents,
    readonly errorCollector?: ErrorCollector) {}

  /** Directory the frame currently on top should resolve includes against. */
  private currentDir(): string | undefined {
    return this.stack.length ? this.stack[this.stack.length - 1].dir : undefined;
  }

  // Hand the whole search list to the frontend and let it report the winner. A
  // frontend that finds nothing returns undefined
  loadFile<T>(path: string, bases: string[],
             resolve: (bases: readonly string[], filename: string) => ResolvedFile<T> | undefined,
             at?: Token): {content: T, base: string} {
    const found = resolve(bases, path);
    if (found) {
      const base = bases[found.baseIndex];
      // A frontend that reports a base it wasn't offered is broken; say so here rather
      // than letting an undefined leak into the resolved path.
      if (base === undefined) {
        Tokens.fail(
            `Resolver returned out-of-range base index ${found.baseIndex} for ${path} ` +
            `(${bases.length} bases were offered)`, at);
      }
      return {content: found.content, base};
    }
    // Report against the .include/.incbin line so the diagnostic carries a source location.
    Tokens.fail(`Could not find file ${path} in include directories: ${bases.join(",")}`, at);
  }

  /** Search list for a `.include`. Including file's dir first, then -I dirs.
   * TODO: Support the other include path things like the CA65_INC env var
  */
  private includeSearch(): string[] {
    return searchList(this.currentDir(), this.opts?.includePaths ?? ['./']);
  }

  private binIncludeSearch(): string[] {
    const paths = this.opts?.binIncludePaths?.length ? this.opts.binIncludePaths :
        this.opts?.includePaths?.length ? this.opts.includePaths : [];
    return searchList(this.currentDir(), [...paths, './']);
  }

  next(): Token[]|undefined {
    while (this.stack.length) {
      const frame = this.stack[this.stack.length - 1];
      const front = frame.queue;
      if (front.length) return front.pop()!;
      const line = frame.source?.next();
      if (line) return line;
      this.stack.pop();
    }
    return undefined;
  }

  include(path: string, at?: Token): void {
    if (!this.resolveFile) {
      Tokens.fail(`Cannot read file, no reader available: ${path}`, at);
    }
    // TODO - options?
    const {content: code, base} = this.loadFile<string>(
        path, this.includeSearch(), this.resolveFile, at);
    // Dont use the name of the file for the include, use the resolved
    // path so that two "header.inc" files in different dirs have the correct path.
    const resolved = joinDir(base, path);
    // Nested includes resolve relative to this file's own directory.
    this.enter(new Tokenizer(code, resolved, this.opts, this.sourceContents,
                             this.errorCollector),
               joinDir(base, dirOf(path)));
  }

  /** Pushes one of the built-in macro packages onto the stack. */
  macpack(pack: string, at?: Token): void {
    const code = MACPACK.get(pack);
    if (code == null) Tokens.fail(`Unknown macpack: ${pack}`, at);
    this.enter(new Tokenizer(code, `${pack}.macpack`, this.opts, this.sourceContents,
                             this.errorCollector));
  }

  incbin(path: string, offset: number, length: number|undefined,
         at?: Token): string {
    if (!this.resolveFileBinary) {
      Tokens.fail(`Cannot read binary file, no reader available: ${path}`, at);
    }
    const loaded = this.loadFile<Uint8Array|string>(
        path, this.binIncludeSearch(), this.resolveFileBinary, at);
    // The callback hands back either base64 or bytes, and the caller may slice
    // it, so decode to bytes, slice, then re-encode.
    // TODO this is a little jank, but we base64 encode the binary file for now
    // so it can be loaded faster without parsing later.
    const bytes = typeof loaded.content === 'string' ?
        new Base64().decode(loaded.content) : loaded.content;
    const end = length !== undefined ? offset + length : undefined;
    return new Base64().encode(bytes.slice(offset, end));
  }

  unshift(...lines: Token[][]) {
    if (!this.stack.length) throw new Error(`Cannot unshift after EOF`);
    const front = this.stack[this.stack.length - 1].queue;
    for (let i = lines.length - 1; i >= 0; i--) {
      front.push(lines[i]);
    }
  }

  // Enter a macro scope, an included file, or the top-level source.
  // dir parameter is the base level include directory for the file,
  // used when dealing with expanding included macros in files (it should inherit
  // the relative include for the file the macro is running in.)
  enter(tokens?: Tokens.Source, dir?: string) {
    let frameDir = dir;
    if (frameDir == null) {
      if (this.stack.length) {
        frameDir = this.stack[this.stack.length - 1].dir;
      } else {
        const file = (tokens as {file?: string} | undefined)?.file;
        frameDir = file ? dirOf(file) : '';
      }
    }
    const frame: Frame = {source:tokens, queue:[], dir:frameDir};
    this.stack.push(frame);
    if (this.stack.length > MAX_DEPTH) throw new Error(`Stack overflow`);
  }

  // Exit a macro scope prematurely.
  exit() {
    this.stack.pop();
  }
  // options(): Tokenizer.Options {
  //   return this.task.opts;
  // }
}
