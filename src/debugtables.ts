// SPDX-License-Identifier: MPL-2.0

import type {Chunk, DebugFile, DebugLine, DebugRun} from './module.ts';
import {DEBUG_LINE_ASM, DEBUG_LINE_MACRO} from './module.ts';
import type {SourceInfo} from './token.ts';

/** Element types of the data directives, as ld65 spells them. */
export const DATA_ELEMENTS = new Map<string, {size: number, type: string}>([
  ['.byte', {size: 1, type: '20'}],
  ['.word', {size: 2, type: '21'}],
  ['.dbyt', {size: 2, type: '51'}],
  ['.faraddr', {size: 3, type: '4200'}],
]);

/** element count is written out in little endian as ca65 does it */
export function arrayType(count: number, element: string): string {
  let sizeBytes = '';
  let n = count;
  let bytes = 0;
  do {
    sizeBytes += (n & 0xff).toString(16).toUpperCase().padStart(2, '0');
    n = Math.floor(n / 256);
    bytes++;
  } while (n);
  const head = (0x80 | (bytes - 1)).toString(16).toUpperCase().padStart(2, '0');
  return head + sizeBytes + element;
}

/** Collects the files, lines and byte runs of one module while it assembles. */
export class DebugBuilder {
  readonly files: DebugFile[] = [];
  readonly lines: DebugLine[] = [];
  readonly lineSets: number[][] = [];
  readonly types: string[] = [];

  private readonly fileIds = new Map<string, number>();
  /** Per file, line ids keyed by line, type and count. */
  private readonly lineIds = new Map<string, Map<number, number>>();
  /**
   * Trie over the line ids of each set.
   * This holds the tree structure for the call stack active on this line.
   * For most lines, this is just one deep for the current line, but during macro
   * expansion this can get fairly deep. For a macro expansion, the body line is the
   * "root" and maps to each of the call sites for that macro. Each node in this tree is
   * shared by using only an index into the lineSets instead of copying everything.
   */
  private readonly setTrie: SetNode = {};
  private readonly typeIds = new Map<string, number>();

  fileId(name: string): number {
    let id = this.fileIds.get(name);
    if (id === undefined) {
      id = this.files.length;
      this.files.push({name, size: 0, mtime: 0});
      this.fileIds.set(name, id);
    }
    return id;
  }

  private line(file: string, line: number, type: number, count: number): number {
    let ids = this.lineIds.get(file);
    if (!ids) this.lineIds.set(file, ids = new Map());
    const key = (line * 4 + type) * 0x10000 + count;
    let id = ids.get(key);
    if (id === undefined) {
      id = this.lines.length;
      this.lines.push({file: this.fileId(file), line, type, count});
      ids.set(key, id);
    }
    return id;
  }

  /** The statement's own line. */
  lineId(src: SourceInfo): number {
    return this.lineChain(src)[0];
  }

  /** Builds out the macro call chain (or just all the lines that share the same source line) */
  lineSet(src: SourceInfo): number {
    return this.internSet(this.lineChain(src));
  }

  /** Every line active at `src` starting from the innermost. */
  lineChain(src: SourceInfo): number[] {
    const ids: number[] = [];
    let depth = ancestors(src);
    for (let s: SourceInfo|undefined = src; s; s = s.parent, depth--) {
      if (s.repeat && s.repeatEnd) {
        ids.push(this.line(s.file, s.line, DEBUG_LINE_ASM, s.repeat));
        ids.push(...this.lineChain(s.repeatEnd));
        break;
      }
      ids.push(this.line(s.file, s.line, depth ? DEBUG_LINE_MACRO : DEBUG_LINE_ASM, depth));
    }
    return ids;
  }

  /** The start of the most line read from the file starting from this current root */
  asmLine(src: SourceInfo): number {
    let root = src;
    for (;;) {
      while (root.parent) root = root.parent;
      if (!root.repeatEnd) break;
      root = root.repeatEnd;
    }
    return this.line(root.file, root.line, DEBUG_LINE_ASM, 0);
  }

  private internSet(ids: number[]): number {
    let node = this.setTrie;
    for (const line of ids) {
      const next = node.next ??= new Map();
      let child = next.get(line);
      if (!child) next.set(line, child = {});
      node = child;
    }
    if (node.set === undefined) {
      node.set = this.lineSets.length;
      this.lineSets.push(ids);
    }
    return node.set;
  }

  typeId(type: string): number {
    let id = this.typeIds.get(type);
    if (id === undefined) {
      id = this.types.length;
      this.types.push(type);
      this.typeIds.set(type, id);
    }
    return id;
  }

  addRun(chunk: Chunk|{debugRuns?: DebugRun[]}, offset: number, size: number,
         set: number, type: number) {
    (chunk.debugRuns ??= []).push([set, offset, size, type]);
  }
}

interface SetNode {
  set?: number;
  next?: Map<number, SetNode>;
}

function ancestors(src: SourceInfo): number {
  let n = 0;
  for (let s = src.parent; s; s = s.parent) n++;
  return n;
}

const encoder = new TextEncoder();
export function utf8Length(s: string): number {
  return encoder.encode(s).length;
}
