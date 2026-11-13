// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect, beforeAll, afterAll} from 'bun:test';
import {assemble, compile, compileRequest, deserializeObjectFile, findOutput, link,
        type AssemblyInput, type Js65Options} from '../src/libassembler.ts';
import type {ListingIndex} from '../src/listing.ts';
import {parseModule} from '../src/validate_modules.ts';
import {setJsEngine} from '../src/driver/js/engine.ts';
import {functionEngine} from '../src/driver/js/function.ts';
import {fileCallbacksFor} from '../src/worker/filecache.ts';

const source = (code: string, name = 'main.s'): AssemblyInput => ({type: 'source', code, name});
const options = {target: 'sim', generateListingFile: true, generateListingIndex: true};
const decode = (data?: Uint8Array) => new TextDecoder().decode(data);

function listing(inputs: AssemblyInput[], opts: Js65Options = {}) {
  const result = compile(inputs, {...options, ...opts});
  expect(result.messages.filter(m => m.level === 'error')).toEqual([]);
  expect(result.success).toBe(true);
  const text = decode(findOutput(result, 'listing')?.data);
  const index = JSON.parse(decode(findOutput(result, 'listing-index')?.data)) as ListingIndex;
  const lines = text.trimEnd().split('\n');
  expect(index.rows.length).toBe(lines.length);
  for (const row of index.rows) {
    expect(row.row).toBeGreaterThan(0);
    if (row.instruction) {
      expect(lines[row.row - 1].slice(row.instruction.start, row.instruction.end))
          .toBe(row.instruction.mnemonic);
    }
    if (index.linked && row.fileOffset != null && row.authored) {
      const file = row.output === '%O' ? findOutput(result, 'binary') :
          result.outputs.find(o => o.name === row.output);
      expect([...file!.data.slice(row.fileOffset, row.fileOffset + row.bytes.length)])
          .toEqual(row.bytes as number[]);
    }
  }
  return {result, text, index, rows: index.rows.filter(r => r.authored)};
}

describe('listing records and writer', () => {
  it('matches the reviewed linked listing', () => {
    const {text} = listing([source('.org $600\nstart: lda #3\nbne start\n.byte 1,2\n', 'example.s')]);
    expect(text).toBe(`js65 listing v1 (linked)
SOURCE  SEGMENT  ADDRESS  BYTES             ASSEMBLY
MODULE example.s
example.s:1                                    .org $0600
example.s:2  CODE  0600                            start :
example.s:2  CODE  0600   A9 03                    lda #$03
example.s:3  CODE  0602   D0 FC                    bne $0600
example.s:4  CODE  0604   01 02                    .byte $01 , $02
<synthetic>  CODE  0200                            <gap 1024 bytes>
`);
  });

  it('matches the reviewed compile-only listing', () => {
    const {text} = listing([source('.segment "CODE"\n.import addr\nlda addr\n.word addr\n', 'example.s')],
                           {outputFormat: 'object'});
    expect(text).toBe(`js65 listing v1 (segment-relative; ?? = unresolved)
SOURCE  SEGMENT  ADDRESS  BYTES             ASSEMBLY
MODULE example.s
example.s:1  CODE                                  .segment "CODE"
example.s:2  CODE                                  .import addr
example.s:3  CODE[0]  0000r  AD ?? ??                 lda addr
example.s:4  CODE[0]  0003r  ?? ??                    .word addr
`);
  });
  it('writes final instructions, data, labels, and non-emitting rows', () => {
    const {text, rows, index} = listing([source('.org $8000\nstart: LDA #3\nbne start\n.byte $ea,2\nend:\n')]);
    expect(rows.map(r => r.bytes)).toEqual([[0xa9, 3], [0xd0, 0xfc], [0xea, 2]]);
    expect(rows.map(r => r.address)).toEqual([0x8000, 0x8002, 0x8004]);
    expect(rows.map(r => r.kind)).toEqual(['instruction', 'instruction', 'data']);
    expect(text).toContain('bne $8000');
    expect(text).toContain('start :');
    expect(text).toContain('.org $8000');
    expect(index.rows.find(r => r.source?.line === 5)?.address).toBe(0x8006);
  });

  it('splits long byte runs without inventing instruction tokens', () => {
    const {rows} = listing([source('.org $600\n.res 19, $ea\n')]);
    expect(rows.map(r => r.bytes.length)).toEqual([8, 8, 3]);
    expect(rows.map(r => r.address)).toEqual([0x600, 0x608, 0x610]);
    expect(rows.map(r => r.continuation)).toEqual([undefined, true, true]);
    expect(rows.every(r => !r.instruction && r.kind === 'reservation')).toBe(true);
  });

  it('preserves macro call sites, definitions, and included-file provenance', () => {
    const code = '.org $600\n.include "part.inc"\n';
    const result = compile([source(code)], options, fileCallbacksFor(new Map([
      ['part.inc', '.macro emit v\nlda #v\n.endmacro\nemit 7\n.byte 8\n'],
    ])));
    expect(result.success).toBe(true);
    const index = JSON.parse(decode(findOutput(result, 'listing-index')?.data)) as ListingIndex;
    const instruction = index.rows.find(r => r.kind === 'instruction')!;
    expect(instruction.bytes).toEqual([0xa9, 7]);
    expect(instruction.source).toMatchObject({file: 'part.inc', line: 4});
    expect(instruction.expansion).toEqual(expect.arrayContaining([
      expect.objectContaining({file: 'part.inc', line: 2}),
      expect.objectContaining({file: 'main.s', line: 2}),
    ]));
    expect(index.rows.find(r => r.kind === 'data')?.source?.file).toBe('part.inc');
  });

  it('uses late assembly placement and shrunk addressing modes', () => {
    const {rows} = listing([
      source('.segment "CODE"\n.import value\nlda value\nrts\n'),
      source('.segment "ZEROPAGE"\n.export value\nvalue: .res 1\n', 'zp.s'),
    ], {target: 'sim'});
    expect(rows.find(r => r.kind === 'instruction')).toMatchObject({
      bytes: [0xa5, 0], address: 0x200, instruction: {mnemonic: 'lda', mode: 'zpg'},
    });
  });

  it('retains input order across sparse origins and vector writes', () => {
    const {rows, index} = listing([source('.segment "ALL" :size $10000 :mem 0 :off 0\n.org $8000\nentry: nop\n.org $fffa\n.word entry,entry,entry\n.org $9000\n.byte 7\n')],
                                 {target: undefined});
    expect(rows.map(r => r.address)).toEqual([0x8000, 0xfffa, 0x9000]);
    expect(rows[1].bytes).toEqual([0, 0x80, 0, 0x80, 0, 0x80]);
    expect(index.rows.some(r => r.kind === 'gap' && !r.authored)).toBe(true);
  });

  it('distinguishes fill, RAM reservations, banks, and output files', () => {
    const code = '.segment "A" :bank 2 :size 16 :mem $8000 :off 0 :fill $ff :out "a.bin"\n' +
      '.org $8004\n.byte 1,2\n.segment "RAM" :size 16 :mem $200 :bss\n.res 3\n';
    const {index} = listing([source(code)]);
    expect(index.rows.find(r => r.kind === 'data')).toMatchObject({
      address: 0x8004, fileOffset: 4, output: 'a.bin', bank: 2, bytes: [1, 2],
    });
    expect(index.rows.some(r => r.kind === 'fill' && !r.authored)).toBe(true);
    expect(index.rows.find(r => r.segment === 'RAM' && r.bytes.length)).toMatchObject({
      kind: 'reservation', address: 0x200,
    });
  });

  it('reports run addresses separately from ROM offsets', () => {
    const linkerConfig = `MEMORY {
      RAM: start = $300, size = $100;
      PRG: start = $8000, size = $100, file = %O;
    } SEGMENTS { BOOT: load = PRG, run = RAM; CODE: load = PRG; }`;
    const {rows} = listing([source('.segment "BOOT"\nstart: lda start\n.segment "CODE"\njmp start\n')],
                           {linkerConfig});
    expect(rows[0]).toMatchObject({address: 0x300, fileOffset: 0, bytes: [0xad, 0, 3]});
    expect(rows[1]).toMatchObject({address: 0x8003, fileOffset: 3, bytes: [0x4c, 0, 3]});
  });

  it('records byte continuations across mirrored placements', () => {
    const linkerConfig = `MEMORY {
      A: start = $8000, size = 16, file = %O;
      B: start = $8000, size = 16, file = %O;
    } SEGMENTS { BOTH: mirror = {A, B}; }`;
    const {rows} = listing([source('.segment "BOTH"\nlda #7\n')], {linkerConfig});
    expect(rows.filter(r => r.instruction).map(r => r.fileOffset)).toEqual([0, 16]);
    expect(rows.filter(r => r.instruction).map(r => r.bytes)).toEqual([[0xa9, 7], [0xa9, 7]]);
  });

  it('retains trailing alignment bytes', () => {
    for (const prefix of ['.org $600\n', '.segment "CODE"\n']) {
      const {rows} = listing([source(prefix + '.byte 1\n.align 4, $ea\n')]);
      expect(rows.flatMap(r => r.bytes)).toEqual([1, 0xea, 0xea, 0xea]);
    }
  });

  it('marks compile-only offsets and unresolved bytes explicitly', () => {
    const {text, rows, result} = listing([source('.segment "CODE"\n.import addr\nLDA addr\n.word addr\n')],
                                        {outputFormat: 'object'});
    expect(text).toContain('segment-relative');
    expect(text).toContain('0000r');
    expect(rows.map(r => r.bytes)).toEqual([[0xad, null, null], [null, null]]);
    expect(rows.every(r => r.relative && r.chunk === 0 && r.fileOffset == null)).toBe(true);
    expect(deserializeObjectFile(findOutput(result, 'object')!.data).debug?.listing?.length)
        .toBeGreaterThan(0);
  });

  it('round trips implicit debug metadata through object files', () => {
    const object = compile([source('.org $600\nfoo: lda #3\n')],
                           {...options, outputFormat: 'object', generateDebugInfo: false});
    const module = deserializeObjectFile(findOutput(object, 'object')!.data);
    const direct = listing([source('.org $600\nfoo: lda #3\n')]);
    const loaded = listing([{type: 'module', module}]);
    expect(loaded.text).toBe(direct.text);
    expect(loaded.index).toEqual(direct.index);
  });

  it('preserves repeated macro provenance through object serialization', () => {
    const inputs = [source('.macro emit v\nlda #v\n.endmacro\n.repeat 2\nemit 3\n.endrepeat\n')];
    const object = compile(inputs, {...options, outputFormat: 'object'});
    const module = deserializeObjectFile(findOutput(object, 'object')!.data);
    expect(listing([{type: 'module', module}]).index).toEqual(listing(inputs).index);
  });

  it('maps included binary data without expanding its text into the listing', () => {
    const result = compile([source('.incbin "blob.bin"\n')], options,
        fileCallbacksFor(new Map([['blob.bin', new Uint8Array(20).fill(0xea)]])));
    expect(result.success).toBe(true);
    const text = decode(findOutput(result, 'listing')?.data);
    expect(text).toContain('.bytestr <binary data>');
    const index = JSON.parse(decode(findOutput(result, 'listing-index')?.data)) as ListingIndex;
    expect(index.rows.filter(r => r.authored).flatMap(r => r.bytes))
        .toEqual(new Array(20).fill(0xea));
    expect(index.rows.every(r => !r.instruction)).toBe(true);
  });

  it('collects nothing unless requested and keeps output opt-in', () => {
    const inputs = [source('.org $600\nnop\n')];
    expect(assemble(inputs).modules[0].debug?.listing).toBeUndefined();
    expect(compile(inputs, {target: 'sim'}).outputs.map(o => o.type)).toEqual(['binary']);
    expect(compile(inputs, {target: 'sim', generateListingFile: true}).outputs.map(o => o.type))
        .toEqual(['binary', 'listing']);
  });

  it('shares debug runs and preserves the existing dbg output', () => {
    const inputs = [source('.macro emit v\nlda #v\n.endmacro\nstart: emit 3\nbne start\n.byte 1,2\n')];
    const debugOptions = {target: 'sim', generateDebugInfo: true, generateDbgFile: true};
    const plain = compile(inputs, debugOptions);
    const combined = compile(inputs, {...debugOptions, ...options});
    expect(combined.success).toBe(true);
    expect(findOutput(combined, 'debug')?.data).toEqual(findOutput(plain, 'debug')?.data);
    const module = assemble(inputs, {generateDebugInfo: true}).modules[0];
    const records = module.debug!.listing!;
    const references = records.flatMap(r => r.spans);
    expect(references.length).toBe(module.chunks!.reduce((n, c) => n + (c.debugRuns?.length ?? 0), 0));
    expect(references.every(r => module.chunks![r.chunk].debugRuns![r.run])).toBe(true);
  });

  it('builds complete listing metadata with the debug option alone', () => {
    const inputs = [source('.org $600\nstart: lda #3\nbne start\n')];
    const assembled = assemble(inputs, {generateDebugInfo: true});
    const linked = link(assembled.modules, {target: 'sim'});
    expect(linked.success).toBe(true);
    expect(linked.listing!().text).toBe(listing(inputs).text);
    const debugOnly = compile(inputs, {target: 'sim', generateDebugInfo: true});
    expect(findOutput(debugOnly, 'listing')).toBeUndefined();
  });

  it('is deterministic and ties the index to the artifact', () => {
    const inputs = [source('.org $600\nlda #3\n')];
    const a = listing(inputs);
    const b = listing(inputs);
    expect(a.text).toBe(b.text);
    expect(a.index).toEqual(b.index);
    expect(a.index.artifact).not.toBe(listing([source('.org $600\nlda #4\n')]).index.artifact);
  });

  it('rejects invalid options and invalid serialized records', () => {
    const inputs = [source('.org $600\nnop\n')];
    expect(compile(inputs, {generateListingIndex: true}).success).toBe(false);
    expect(compileRequest(JSON.stringify({inputs, options: {generateListingFile: 'yes'}})).success)
        .toBe(false);
    const module = assemble(inputs, {generateDebugInfo: true}).modules[0];
    module.debug!.listing![1].spans[0].run = 999;
    expect(parseModule(module).ok).toBe(false);
  });

  it('never emits a listing after assembly or link failures', () => {
    for (const code of ['bad_opcode', '.org $600\n.import missing\nlda missing\n']) {
      const result = compile([source(code)], options);
      expect(result.success).toBe(false);
      expect(result.outputs.some(o => o.type.startsWith('listing'))).toBe(false);
    }
  });
});

describe('generated listing records', () => {
  beforeAll(() => setJsEngine(functionEngine));
  afterAll(() => setJsEngine(undefined));

  it('lists generated actions and code in emission order', () => {
    const {rows} = listing([source('.org $600\n.jsbegin\na.byte([1, 2]);\na.word([0x1234]);\n.jsend\n'),
      {type: 'actions', actions: [{action: 'org', addr: 0x700},
        {action: 'code', code: 'lda #7'}]}],
                           {allowJavascript: true});
    expect(rows.map(r => r.bytes)).toEqual([[1, 2], [0x34, 0x12], [0xa9, 7]]);
    expect(rows.map(r => r.kind)).toEqual(['data', 'data', 'instruction']);
  });

  it('uses final postprocessed bytes and suppresses changed opcode tokens', () => {
    const {rows} = listing([source('.org $600\nlda #7\n.jspostbegin\nrom[0x400] = 0xea;\n.jspostend\n')],
                           {allowJavascript: true});
    expect(rows[0].bytes).toEqual([0xea, 7]);
    expect(rows[0].instruction).toBeUndefined();
  });

  it('diagnoses postprocessing that removes listed bytes', () => {
    const result = compile([source('lda #7\n.jspostbegin\nrom.buffer.resize(1);\n.jspostend\n')],
                           {...options, allowJavascript: true});
    expect(result.success).toBe(false);
    expect(result.messages.some(m => m.message.includes('postprocessing truncated'))).toBe(true);
    expect(findOutput(result, 'listing')).toBeUndefined();
  });
});
