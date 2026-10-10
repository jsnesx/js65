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
  private readonly lineIds = new Map<string, number>();
  private readonly setIds = new Map<string, number>();
  private readonly typeIds = new Map<string, number>();
  /** Line set of a source with no parent, keyed by file, line and repeat. */
  private readonly plainSets = new Map<string, number>();

  fileId(name: string): number {
    let id = this.fileIds.get(name);
    if (id === undefined) {
      id = this.files.length;
      this.files.push({name, size: 0, mtime: 0});
      this.fileIds.set(name, id);
    }
    return id;
  }

  lineId(src: SourceInfo, depth = ancestors(src)): number {
    const type = src.parent ? DEBUG_LINE_MACRO : DEBUG_LINE_ASM;
    const count = depth + (src.repeat ?? 0);
    const key = `${src.file}\0${src.line}\0${type}\0${count}`;
    let id = this.lineIds.get(key);
    if (id === undefined) {
      id = this.lines.length;
      this.lines.push({file: this.fileId(src.file), line: src.line, type, count});
      this.lineIds.set(key, id);
    }
    return id;
  }

  /** Builds out the macro call chain. Basically all the lines that share the same source line */
  lineSet(src: SourceInfo): number {
    if (!src.parent) {
      const key = `${src.file}\0${src.line}\0${src.repeat ?? 0}`;
      let id = this.plainSets.get(key);
      if (id === undefined) {
        id = this.internSet([this.lineId(src, 0)]);
        this.plainSets.set(key, id);
      }
      return id;
    }
    const ids: number[] = [];
    let depth = ancestors(src);
    for (let s: SourceInfo|undefined = src; s; s = s.parent, depth--) {
      ids.push(this.lineId(s, depth));
    }
    return this.internSet(ids);
  }

  private internSet(ids: number[]): number {
    const key = ids.join(',');
    let id = this.setIds.get(key);
    if (id === undefined) {
      id = this.lineSets.length;
      this.lineSets.push(ids);
      this.setIds.set(key, id);
    }
    return id;
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

  /** Adds bytes to a chunk, joining them to the previous untyped run of the same lines. */
  addRun(chunk: Chunk|{debugRuns?: DebugRun[]}, offset: number, size: number,
         set: number, type: number) {
    const runs = chunk.debugRuns ??= [];
    const last = runs[runs.length - 1];
    if (last && type < 0 && last[3] < 0 && last[0] === set &&
        last[1] + last[2] === offset) {
      last[2] += size;
      return;
    }
    runs.push([set, offset, size, type]);
  }
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
