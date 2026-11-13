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

function listing(inputs: AssemblyInput[], opts: Js65Options = {}, baseRom?: Uint8Array) {
  const result = compile(inputs, {...options, ...opts}, undefined, baseRom?.slice());
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

describe('listing placement edge cases', () => {
  const banks = '.segment "B0" :bank 0 :size 8 :mem $8000 :off $10 :fill $ff\n' +
      '.segment "B1" :bank 1 :size 8 :mem $8000 :off $18 :fill $ff\n';

  it('maps pooled chunks to physical banks with either declaration syntax', () => {
    const body = '.segment "MUSIC"\n.byte 1,1,1,1\n' +
        '.segment "MUSIC"\n.byte 2,2,2\n.segment "MUSIC"\n.byte 3,3,3\n';
    const inline = listing([source(banks + '.segment "MUSIC" :pool {"B0", "B1"}\n' + body)],
                           {target: undefined});
    const configured = listing([source(body)], {target: undefined, linkerConfig: `
      MEMORY {
        HEADER: start = 0, size = $10, file = %O, fill = yes;
        B0: start = $8000, size = 8, bank = 0, file = %O, fill = yes, fillval = $ff;
        B1: start = $8000, size = 8, bank = 1, file = %O, fill = yes, fillval = $ff;
      } SEGMENTS { MUSIC: pool = {B0, B1}; }`});
    for (const {rows, index} of [inline, configured]) {
      expect(rows.map(r => [r.segment, r.bank, r.address, r.fileOffset, r.bytes]))
          .toEqual([
            ['B0', 0, 0x8000, 0x10, [1, 1, 1, 1]],
            ['B0', 0, 0x8004, 0x14, [2, 2, 2]],
            ['B1', 1, 0x8000, 0x18, [3, 3, 3]],
          ]);
      expect(index.rows.some(r => r.kind === 'fill' && r.bytes.includes(0xff))).toBe(true);
    }
  });

  const spill = '.segment "BANK" :bank 3 :size $10 :mem $bff0 :off $10\n' +
      '.segment "FIXED" :bank 7 :size 8 :mem $c000 :off $40\n' +
      '.segment "POOL" :pool {"BANK", "FIXED"}\n' +
      '.segment "BANK"\n.org $bffe\n.free 2\n' +
      '.segment "FIXED"\n.org $c000\n.free 4\n';

  it('spills pooled data into fixed memory at a discontinuous ROM offset', () => {
    const {rows, index} = listing([source(spill +
        '.reloc\n.segment "POOL"\nhead: .byte 1,2,3,4,5,6\nend:\n')],
        {target: undefined});
    expect(rows.filter(r => r.kind === 'data').map(r =>
        [r.segment, r.bank, r.address, r.fileOffset, r.bytes])).toEqual([
      ['BANK', 3, 0xbffe, 0x1e, [1, 2]],
      ['FIXED', 7, 0xc000, 0x40, [3, 4, 5, 6]],
    ]);
    expect(index.rows.find(r => r.source?.line === 13))
        .toMatchObject({address: 0xc004, segment: 'FIXED', fileOffset: 0x44});
  });

  it('preserves split instruction bytes and labels across the bank boundary', () => {
    const {rows, index} = listing([source(spill +
        '.reloc\n.segment "POOL"\njsr tail\ntail: rts\n.byte 1,2\n')],
        {target: undefined});
    const instructions = rows.filter(r => r.kind === 'instruction');
    expect(instructions.map(r => [r.address, r.fileOffset, r.bytes])).toEqual([
      [0xbffe, 0x1e, [0x20, 0x01]], [0xc000, 0x40, [0xc0]], [0xc001, 0x41, [0x60]],
    ]);
    expect(instructions.slice(0, 2).every(r => !r.instruction)).toBe(true);
    expect(instructions[2].instruction?.mnemonic).toBe('rts');
    expect(index.rows.find(r => r.source?.line === 13 && !r.authored))
        .toMatchObject({address: 0xc001, segment: 'FIXED'});
  });

  it('omits listing outputs when a pool spill cannot fit', () => {
    const result = compile([source(spill +
        '.reloc\n.segment "POOL"\n.byte 1,2,3,4,5,6,7\n')],
        {...options, target: undefined});
    expect(result.success).toBe(false);
    expect(result.messages.some(m => m.message.includes('Could not find space'))).toBe(true);
    expect(result.outputs.some(o => o.type.startsWith('listing'))).toBe(false);
  });

  it('combines base ROM patching, pooled spills, and multiple input modules', () => {
    const inputs = [source(spill, 'layout.s'), source(
        '.segment "POOL"\n.export tail\njsr tail\ntail: rts\n.byte 1,2\n', 'patch.s')];
    const base = new Uint8Array(0x50).fill(0x5a);
    const {rows, result, index} = listing(inputs, {target: undefined}, base);
    expect(rows.map(r => [r.module, r.bank, r.address, r.fileOffset, r.bytes])).toEqual([
      ['patch.s', 3, 0xbffe, 0x1e, [0x20, 0x01]],
      ['patch.s', 7, 0xc000, 0x40, [0xc0]],
      ['patch.s', 7, 0xc001, 0x41, [0x60]],
      ['patch.s', 7, 0xc002, 0x42, [1, 2]],
    ]);
    const binary = findOutput(result, 'binary')!.data;
    expect(binary.slice(0x20, 0x40)).toEqual(base.slice(0x20, 0x40));
    expect(index.rows.filter(r => r.kind === 'gap').every(r => !r.authored)).toBe(true);
    const plain = compile(inputs, {target: undefined}, undefined, base.slice());
    expect(plain.success).toBe(true);
    expect(findOutput(plain, 'binary')!.data).toEqual(binary);
  });

  it('lists base ROM patches without attributing untouched bytes to source', () => {
    const base = Uint8Array.from({length: 0x60}, (_, i) => i);
    const original = base.slice();
    const inputs = [source(banks + '.segment "B0"\n.org $8002\nlda #$42\n' +
        '.segment "B1"\n.org $8002\n.byte $a5\n')];
    const {rows, result} = listing(inputs, {target: undefined}, base);
    expect(rows.map(r => [r.bank, r.address, r.fileOffset, r.bytes])).toEqual([
      [0, 0x8002, 0x12, [0xa9, 0x42]], [1, 0x8002, 0x1a, [0xa5]],
    ]);
    expect(findOutput(result, 'binary')!.data.slice(0, 0x10)).toEqual(original.slice(0, 0x10));
    expect(findOutput(result, 'binary')!.data.slice(0x20)).toEqual(original.slice(0x20));
    expect(base).toEqual(original);
    const ips = compile(inputs, {...options, target: undefined, outputFormat: 'ips'}, undefined, base.slice());
    expect(ips.success).toBe(true);
    expect(decode(findOutput(ips, 'binary')!.data.slice(0, 5))).toBe('PATCH');
    expect(findOutput(ips, 'listing')!.data).toEqual(findOutput(result, 'listing')!.data);
    expect(findOutput(ips, 'listing-index')!.data).toEqual(findOutput(result, 'listing-index')!.data);
  });

  it('preserves independent module chunks and linked operands through objects', () => {
    const inputs = [
      source('.segment "CODE"\n.import helper\njsr helper\nrts\n', 'caller.s'),
      source('.segment "CODE"\n.export helper\nhelper: lda #7\nrts\n', 'helper.s'),
    ];
    const direct = listing(inputs);
    const objects: AssemblyInput[] = inputs.map(input => {
      const result = compile([input], {...options, outputFormat: 'object'});
      expect(result.success).toBe(true);
      return {type: 'module', module: deserializeObjectFile(findOutput(result, 'object')!.data)};
    });
    expect(direct.rows.map(r => [r.module, r.address, r.bytes])).toEqual([
      ['caller.s', 0x200, [0x20, 0x04, 0x02]], ['caller.s', 0x203, [0x60]],
      ['helper.s', 0x204, [0xa9, 7]], ['helper.s', 0x206, [0x60]],
    ]);
    expect(listing(objects).index).toEqual(direct.index);
    expect(listing([inputs[0], objects[1]]).index).toEqual(direct.index);
  });

  it('shows unmapped objects without guessing instruction tokens', () => {
    const module = assemble([source('lda #7\n', 'opaque.s')]).modules[0];
    const {text, rows} = listing([{type: 'module', module}, source('rts\n', 'visible.s')]);
    expect(text).toContain('Source records unavailable; bytes are unmapped.');
    expect(rows[0]).toMatchObject({bytes: [0xa9, 7], address: 0x200});
    expect(rows[0].instruction).toBeUndefined();
    expect(rows[1]).toMatchObject({module: 'visible.s', bytes: [0x60], address: 0x202});
  });

  it('keeps mirror offsets local to each output file', () => {
    const {rows} = listing([source('.segment "BOTH"\n.res 11,$a5\n')], {
      target: undefined, linkerConfig: `MEMORY {
        HEADER: start = 0, size = 4, file = %O, fill = yes;
        A: start = $8000, size = 16, bank = 2, file = %O;
        B: start = $8000, size = 16, bank = 5, file = "other.bin";
      } SEGMENTS { BOTH: mirror = {A, B}; }`,
    });
    expect(rows.map(r => [r.segment, r.bank, r.output, r.fileOffset, r.address, r.size]))
        .toEqual([
          ['A', 2, '%O', 4, 0x8000, 8], ['A', 2, '%O', 12, 0x8008, 3],
          ['B', 5, 'other.bin', 0, 0x8000, 8], ['B', 5, 'other.bin', 8, 0x8008, 3],
        ]);
    expect(rows.map(r => r.continuation)).toEqual([undefined, true, undefined, true]);
  });

  it('retains both source records when identical chunks share ROM bytes', () => {
    const {rows} = listing([
      source('.segment "CODE" :dedupe\n.byte 1,2,3\n', 'first.s'),
      source('.segment "CODE"\n.byte 1,2,3\n', 'second.s'),
    ]);
    expect(rows.map(r => r.source?.file)).toEqual(['first.s', 'second.s']);
    expect(rows.map(r => r.bytes)).toEqual([[1, 2, 3], [1, 2, 3]]);
    expect(rows.map(r => r.fileOffset)).toEqual([0, 0]);
  });

  it('retains empty modules and labels without inventing authored bytes', () => {
    const {index, rows, text} = listing([
      source('', 'empty.s'), source('.segment "CODE"\nstart:\n.res 0\n', 'labels.s'),
      source('nop\n', 'code.s'),
    ]);
    expect(text).toContain('MODULE empty.s');
    expect(rows.map(r => r.bytes)).toEqual([[0xea]]);
    expect(index.rows.find(r => r.module === 'labels.s' && r.source?.line === 2))
        .toMatchObject({address: 0x200, bytes: [], size: 0, authored: false});
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

  it('lists final IPS postprocessing bytes over a base ROM', () => {
    const inputs = [source('lda #7\n.jspostbegin\nrom[1] = 9;\n.jspostend\n')];
    const base = new Uint8Array(16).fill(0xff);
    const binary = listing(inputs, {allowJavascript: true}, base);
    const ips = compile(inputs, {...options, allowJavascript: true, outputFormat: 'ips'},
                        undefined, base.slice());
    expect(ips.success).toBe(true);
    expect(binary.rows[0]).toMatchObject({bytes: [0xa9, 9], instruction: {mnemonic: 'lda'}});
    expect(findOutput(ips, 'listing')!.data).toEqual(findOutput(binary.result, 'listing')!.data);
    expect(findOutput(ips, 'listing-index')!.data).toEqual(findOutput(binary.result, 'listing-index')!.data);
  });
});
