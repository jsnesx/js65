// SPDX-License-Identifier: MPL-2.0

import {Cpu, type AddressingMode} from './cpu.ts';
import type {SourceInfo} from './error.ts';
import type {Module} from './module.ts';
import {createHash} from 'sha1-uint8array';

export type ListingKind = 'source'|'instruction'|'data'|'reservation'|'gap'|'fill';

export interface ListingSpan {
  chunk: number;
  run: number;
}

export interface ListingRecord {
  text: string;
  source?: SourceInfo;
  kind: ListingKind;
  segments: string[];
  spans: ListingSpan[];
  anchor?: {chunk: number, offset: number};
  instruction?: {mnemonic: string, mode: AddressingMode};
}

export interface ListingPlacement {
  start: number;
  size: number;
  address: number;
  segment: string;
  bank?: number;
  output?: string;
  fileOffset?: number;
  bytes: Uint8Array;
  reservation?: boolean;
}

export interface ListingModule {
  module: Module;
  chunks: ListingPlacement[][];
}

export interface ListingRow {
  row: number;
  kind: ListingKind|'header';
  source?: SourceInfo;
  expansion: SourceInfo[];
  synthetic: boolean;
  segment?: string;
  bank?: number;
  output?: string;
  address?: number;
  fileOffset?: number;
  relative?: boolean;
  bytes: (number|null)[];
  size: number;
  authored: boolean;
  continuation?: boolean;
  chunk?: number;
  module?: string;
  instruction?: {mnemonic: string, mode: AddressingMode, start: number, end: number};
}

export interface ListingIndex {
  version: 1;
  artifact: string;
  linked: boolean;
  rows: ListingRow[];
}

export interface ListingArtifact {
  text: string;
  index: ListingIndex;
}

const hex = (n: number, width = 4) => n.toString(16).toUpperCase().padStart(width, '0');
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, c =>
    c === '\t' ? ' ' : `\\u${hex(c.charCodeAt(0))}`);

export function relativeListingModules(modules: readonly Module[]): ListingModule[] {
  return modules.map(module => ({module, chunks: (module.chunks ?? []).map(chunk => [{
    start: 0, size: chunk.data.length, address: 0,
    segment: chunk.segments.join('|'), bytes: chunk.data,
  }])}));
}

export function writeListing(modules: readonly ListingModule[], linked: boolean,
                             synthetic: readonly ListingPlacement[] = []): ListingArtifact {
  const lines: string[] = [];
  const rows: ListingRow[] = [];
  const add = (text: string, row: Omit<ListingRow, 'row'>) => {
    lines.push(ascii(text));
    rows.push({...row, row: rows.length + 1});
  };
  const header = (text: string) => add(text, {
    kind: 'header', expansion: [], synthetic: true, bytes: [], size: 0, authored: false,
  });
  header(`js65 listing v1 (${linked ? 'linked' : 'segment-relative; ?? = unresolved'})`);
  header('SOURCE  SEGMENT  ADDRESS  BYTES             ASSEMBLY');
  const emit = (record: ListingRecord, p?: ListingPlacement, offset = 0,
                size = 0, unresolved = new Set<number>(), module?: string, chunk?: number) => {
    const chain: SourceInfo[] = [];
    for (let s = record.source; s; s = s.parent) chain.push(s);
    const source = chain[chain.length - 1];
    for (const s of [...chain]) {
      for (let include = s.include; include; include = include.include) {
        if (!chain.includes(include)) chain.push(include);
      }
    }
    const gap = record.kind === 'gap';
    const count = gap ? 1 : Math.max(1, Math.ceil(size / 8));
    for (let i = 0; i < count; i++) {
      const at = offset + i * 8;
      const length = gap ? 0 : Math.min(8, size - i * 8);
      const bytes = Array.from({length}, (_, k) =>
          unresolved.has(at + k) || p?.reservation ? null : p!.bytes[at + k - p!.start]);
      const address = p && p.address + at - p.start;
      const segment = p?.segment ?? record.segments.join('|');
      const location = source ? `${ascii(source.file)}:${source.line}` : '<synthetic>';
      const prefix = `${location}  ${ascii(segment)}${!linked && chunk != null ? `[${chunk}]` : ''}  ${address == null ? '     ' :
          hex(address) + (linked ? ' ' : 'r')}  ${bytes.map(b => b == null ? '??' : hex(b, 2))
          .join(' ').padEnd(23)}  `;
      let text = gap ? `<gap ${size} bytes>` : i ? '+' : record.text;
      const instruction = !i && !p?.reservation && record.instruction &&
          size === 1 + Cpu.P02.argLen(record.instruction.mode) &&
          Cpu.P02.op(record.instruction.mnemonic)?.[record.instruction.mode] === bytes[0] &&
          record.instruction;
      if (instruction) text = instruction.mnemonic + text.slice(text.search(/\s|$/));
      if (instruction && linked && bytes.length && bytes.every(b => b != null)) {
        const value = (bytes[1] ?? 0) + ((bytes[2] ?? 0) << 8);
        const operand = instruction.mode === 'rel' ?
            `$${hex((address! + 2 + (value > 127 ? value - 256 : value)) & 0xffff)}` :
            Cpu.P02.format(instruction.mode, value);
        text = `${instruction.mnemonic}${operand ? ' ' + operand : ''}`;
      }
      add(prefix + text, {
        kind: record.kind === 'gap' ? 'gap' : p?.reservation ? 'reservation' : record.kind,
        source, expansion: chain, synthetic: !source,
        segment, bank: p?.bank, output: p?.output, address,
        fileOffset: p?.fileOffset == null ? undefined : p.fileOffset + at - p.start,
        relative: p ? !linked : undefined, bytes, size: gap ? size : length,
        module, chunk,
        authored: !!size && record.kind !== 'fill' && record.kind !== 'gap',
        continuation: i > 0 || undefined,
        instruction: instruction ? {...instruction, start: prefix.length,
          end: prefix.length + instruction.mnemonic.length} : undefined,
      });
    }
  };
  for (const {module, chunks} of modules) {
    header(`MODULE ${module.name ?? '<module>'}`);
    const records = module.debug?.listing;
    if (!records) {
      header('Source records unavailable; bytes are unmapped.');
      for (const pieces of chunks) for (const p of pieces) {
        emit({text: '<unmapped data>', kind: 'data', segments: [], spans: []}, p, p.start, p.size);
      }
      continue;
    }
    for (const record of records) {
      if (!record.spans.length) {
        const a = record.anchor;
        const pieces = a && chunks[a.chunk];
        const p = pieces?.find(p => a!.offset >= p.start && a!.offset < p.start + p.size) ??
            pieces?.find(p => a!.offset === p.start + p.size);
        emit(record, p, a?.offset, 0, undefined, module.name, a?.chunk);
      }
      for (const span of record.spans) {
        const run = module.chunks?.[span.chunk]?.debugRuns?.[span.run];
        if (!run) throw new Error('Listing references a missing debug run');
        const offset = run[1], size = run[2];
        const unresolved = new Set<number>();
        if (!linked) for (const sub of module.chunks?.[span.chunk]?.subs ?? []) {
          for (let k = 0; k < sub.size; k++) unresolved.add(sub.offset + k);
        }
        for (const p of chunks[span.chunk] ?? []) {
          const start = Math.max(offset, p.start);
          const end = Math.min(offset + size, p.start + p.size);
          if (end > start) emit(record, p, start, end - start, unresolved, module.name, span.chunk);
        }
      }
    }
  }
  for (const p of synthetic) emit({text: p.reservation ? '<gap>' : '<linker fill>',
    kind: p.reservation ? 'gap' : 'fill', segments: [], spans: []}, p, p.start, p.size);
  const text = lines.join('\n') + '\n';
  const metadata = JSON.stringify(rows, (_, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  });
  const hash = createHash().update(new TextEncoder().encode(text + metadata)).digest('hex');
  return {text, index: {version: 1, artifact: `lst1-${hash}`, linked, rows}};
}
