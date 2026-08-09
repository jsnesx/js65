
// SPDX-License-Identifier: MPL-2.0

import * as Exprs from './expr.ts';
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

export interface ReadFileCallback { (path: string, filename: string) : Promise<string> }
export interface ReadFileBinaryCallback { (path: string, filename: string) : Promise<Uint8Array|string> }

export class SourceContents {
  data: Map<string, string> = new Map<string, string>();
}

export class TokenStream implements Tokens.Source {
  private stack: Frame[] = [];

  constructor(
    readonly readFile?: ReadFileCallback,
    readonly readFileBinary?: ReadFileBinaryCallback,
    readonly opts?: Options,
    readonly sourceContents?: SourceContents,
    readonly errorCollector?: ErrorCollector) {}

  /** Directory the frame currently on top should resolve includes against. */
  private currentDir(): string | undefined {
    return this.stack.length ? this.stack[this.stack.length - 1].dir : undefined;
  }

  // Try each search directory in turn, returning the first that loads along with
  // the base it loaded from.
  async loadFile<T>(path: string, bases: string[],
                    action: (path: string, filename: string) => Promise<T>,
                    at?: Token): Promise<{value: T, base: string}> {
    for (const base of bases) {
      try {
        return {value: await action(base, path), base};
      } catch (_e) {
        // unable to load the file at that path, try the next include directory.
      }
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

  /** Search list for a `.incbin`. Including file's dir first, then --bin-include-dir. */
  private binIncludeSearch(): string[] {
    return searchList(this.currentDir(),
                      this.opts?.binIncludePaths ?? this.opts?.includePaths ?? ['./']);
  }

  async next(): Promise<Token[]|undefined> {
    while (this.stack.length) {
      const frame = this.stack[this.stack.length - 1];
      const tok = frame.source;
      const front = frame.queue;
      if (front.length) return front.pop()!;
      const line = await tok?.next();
      if (line) {
        if (line?.[0].token !== 'cs') return line;
        switch (line[0].str) {
          case '.include': {
            const path = this.str(line);
            if (!this.readFile) this.err(line);
            // TODO - options?
            const {value: code, base} = await this.loadFile<string>(
                path, this.includeSearch(), this.readFile, line[0]);
            // Dont use the name of the file for the include, use the resolved
            // path so that two "header.inc" files in different dirs have the correct path.
            const resolved = joinDir(base, path);
            // Nested includes resolve relative to this file's own directory.
            this.enter(new Tokenizer(code, resolved, this.opts, this.sourceContents,
                                     this.errorCollector),
                       joinDir(base, dirOf(path)));
            continue;
          }
          case '.macpack': {
            const pack = Tokens.expectIdentifier(line[1])?.toLowerCase();
            const code = MACPACK.get(pack) ?? this.err(line);
            this.enter(new Tokenizer(code, `${pack}.macpack`, this.opts, this.sourceContents,
                                     this.errorCollector));
            continue;
          }
          case '.incbin': {
            // TODO: consider moving this to an assembler directive so it can just put the
            // whole chunk of bytes into the module and skip tokenizing it.
            if (!this.readFileBinary) this.err(line);
            if (line.length < 1) {
              this.err(line);
            }
            const path = Tokens.expectString(line[1], line[0]);
            let offset = 0;
            let length = undefined;
            if (line.length > 2) {
              const args = Tokens.parseArgList(line, 2);
              if (args[1]) {
                const expr = Exprs.evaluate(Exprs.parseOnly(args[1]));
                offset = expr.num ?? 0;
              }
              if (args[2]) {
                const expr = Exprs.evaluate(Exprs.parseOnly(args[2]));
                length = expr.num ?? -1;
              }
            }
            // TODO this is a little jank, but we base64 encode the binary file for now
            // so it can be loaded faster without parsing later.
            // The data passed in from the call back can either be base64 encoded or a u8 array
            // but because the user can slice the input, its easier to decode to bytes, then slice
            // then reencode for now.
            const loaded = await this.loadFile<Uint8Array|string>(
                path, this.binIncludeSearch(), this.readFileBinary, line[0]);
            let inbytes = (typeof loaded.value === 'string') ? new Base64().decode(loaded.value) : loaded.value;
  
            const end = length !== undefined ? offset + length : undefined;
            const bin = new Base64().encode(inbytes.slice(offset, end));
            const out : Token[] = [
              Tokens.BYTESTR,
              {token: 'str', str: bin}
            ];
            return out;
          }
          default:
            return line;
        }
      }
      this.stack.pop();
    }
    return undefined;
  }

  unshift(...lines: Token[][]) {
    if (!this.stack.length) throw new Error(`Cannot unshift after EOF`);
    const front = this.stack[this.stack.length - 1].queue;
    for (let i = lines.length - 1; i >= 0; i--) {
      front.push(lines[i]);
    }
  }

  // async include(file: string) {
  //   const code = await this.task.parent.readFile(file);
  //   this.stack.push([new Tokenizer(code, file, this.task.opts),  []]);
  // }
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
  
  err(line: Token[]): never {
    Tokens.fail(this.str(line), line[0]);
  }

  str(line: Token[]): string {
    const str = Tokens.expectString(line[1], line[0]);
    Tokens.expectEol(line[2], 'a single string');
    return str;
  }

}
