
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {type Expr} from '../src/expr.ts';
import {type CfgSymbols, configSymbols, linkerDefines, lowerLinkerConfig,
        parseLinkerConfig, resolveCfgExpr} from '../src/linkerconfig.ts';
import {SourceError} from '../src/token.ts';

describe('parseLinkerConfig', function() {

  // Helper function to resolve deferred symbols for testing.
  function areaGeometry(area: {start: Expr, size: Expr}, symbols?: CfgSymbols) {
    return [resolveCfgExpr(area.start, symbols ?? new Map(), 'start'),
            resolveCfgExpr(area.size, symbols ?? new Map(), 'size')];
  }
  function value(expr: Expr|undefined, symbols?: CfgSymbols) {
    return expr == null
        ? undefined
        : resolveCfgExpr(expr, symbols ?? new Map(), 'value');
  }

  function expectSourceError(cfg: string, message: RegExp, line?: number) {
    let err: unknown;
    try {
      parseLinkerConfig(cfg, 'test.cfg');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SourceError);
    expect((err as Error).message).toMatch(message);
    if (line != null) {
      expect((err as SourceError).source).toMatchObject({file: 'test.cfg', line});
    }
  }

  // Sample cfg pulled from a project
  const NROM_CFG = `MEMORY {
    ZEROPAGE:        start = $00,   size = $100,  type = rw;
    SHADOW_OAM:       start = $0200, size = $100,  type = rw;
    RAM:       start = $0300, size = $500,  type = rw;
    PRGRAM:    start = $6000, size = $2000,  type = rw;
    HDR:       start = $0000, size = $10,   type = ro, file = %O, fill = yes;
    PRG_8000:  start = $8000, size = $4000, type = ro, file = %O, fill = yes, fillval = $FF, bank = 0;
    PRG_C000:  start = $C000, size = $4000, type = ro, file = %O, fill = yes, fillval = $FF;
    CHR0:      start = $0000, size = $1000, type = ro, file = %O, fill = yes, fillval = $00;
    CHR1:      start = $0000, size = $1000, type = ro, file = %O, fill = yes, fillval = $00;
}

SEGMENTS {
   ZEROPAGE:  load = ZEROPAGE,  type = zp;
   BSS:        load = RAM,        type = bss, align = $100, define = yes;
   RAM:        load = RAM,        type = bss, start = $0300;
   HEADER:     load = HDR,        type = ro,  align = $10;
   CODE:       load = PRG_C000,   type = ro,  align = $100;
   PRG0_8000:  load = PRG_8000,   type = ro;
   PRG1_C000:  load = PRG_C000,   type = ro,  align = $100;
   VECTORS:    load = PRG_C000,   type = ro,  start = $FFFA;
   CHR0:       load = CHR0,       type = ro,  align = $1000, define = no;
   CHR1:       load = CHR1,       type = ro,  align = $1000, define = no;
}

FILES {
   %O:   format = bin;
}`;

  it('should parse a real nrom config', function() {
    const cfg = parseLinkerConfig(NROM_CFG);
    expect(cfg.memory.length).toBe(9);
    expect(cfg.segments.length).toBe(10);
    expect(cfg.files).toEqual([{name: '%O', format: 'bin'}]);
    const prg8000 = cfg.memory.find(a => a.name === 'PRG_8000')!;
    expect(areaGeometry(prg8000)).toEqual([0x8000, 0x4000]);
    expect(value(prg8000.bank)).toBe(0);
    expect(prg8000).toMatchObject({
      type: 'ro', file: '%O', fill: true, fillval: 0xff, define: false,
    });
    // No `file` attribute at all -- distinct from `file = ""`.
    expect(cfg.memory.find(a => a.name === 'RAM')!.file).toBeUndefined();
    expect(cfg.segments.find(s => s.name === 'VECTORS')).toMatchObject({
      load: 'PRG_C000', run: 'PRG_C000', type: 'ro', start: 0xfffa,
      define: false, optional: false,
    });
    expect(cfg.segments.find(s => s.name === 'BSS')).toMatchObject({
      load: 'RAM', type: 'bss', align: 0x100, define: true,
    });
  });

  it('should preserve declaration order', function() {
    // Areas fix output-file ordering, segments fix within-area placement order.
    const cfg = parseLinkerConfig(NROM_CFG);
    expect(cfg.memory.map(a => a.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(cfg.segments.map(s => s.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(cfg.memory.map(a => a.name)).toEqual([
      'ZEROPAGE', 'SHADOW_OAM', 'RAM', 'PRGRAM', 'HDR',
      'PRG_8000', 'PRG_C000', 'CHR0', 'CHR1',
    ]);
    expect(cfg.segments.map(s => s.name)).toEqual([
      'ZEROPAGE', 'BSS', 'RAM', 'HEADER', 'CODE',
      'PRG0_8000', 'PRG1_C000', 'VECTORS', 'CHR0', 'CHR1',
    ]);
  });

  describe('numbers', function() {
    it('should read every number form a real config uses', function() {
      const cfg = parseLinkerConfig(`
        MEMORY {
          A: start = $00, size = 63, fillval = $FF;
          B: start = 00,  size = 65500;
        }
        SEGMENTS {
          S1: load = A, align = 64;
          S2: load = A, align = $100;
        }
      `);
      expect(cfg.memory.map(a => areaGeometry(a)))
          .toEqual([[0, 63], [0, 65500]]);
      expect(cfg.memory[0].fillval).toBe(0xff);
      expect(cfg.segments.map(s => s.align)).toEqual([64, 256]);
    });

    it('should read a leading-zero number as decimal', function() {
      const cfg = parseLinkerConfig(`
        MEMORY {
          A: start = $0, size = $10, bank = 00;
          B: start = $0, size = $10, bank = 08;
          C: start = $0, size = $10, bank = 09;
          D: start = $0, size = $10, bank = $02;
        }
      `);
      expect(cfg.memory.map(a => value(a.bank))).toEqual([0, 8, 9, 2]);
    });

    it('should fold a constant expression', function() {
      const cfg = parseLinkerConfig(`
        MEMORY { A: start = $8000 + 16, size = $2000 * 2; }
      `);
      expect(areaGeometry(cfg.memory[0])).toEqual([0x8010, 0x4000]);
    });

    it('should require a SEGMENTS align to be constant at parse time', function() {
      expectSourceError(
          `MEMORY { A: start = $0, size = $10; }\n` +
          `SEGMENTS { S: load = A, align = FOO; }`,
          /Value of 'align' must be a constant \(FOO is not defined\)/, 2);
    });

    it('should require MEMORY fillval to be constant at parse time', function() {
      expectSourceError(`MEMORY { A: start = $0, size = $10, fillval = FOO; }`,
                        /Value of 'fillval' must be a constant/, 1);
    });
  });

  // See `resolveCfgExpr` for why these only have to be constant at the moment
  // they are consumed.
  describe('deferred expressions', function() {
    it('should keep a symbolic MEMORY start as a tree rather than failing', function() {
      const cfg = parseLinkerConfig(`MEMORY { A: start = __ONCE_RUN__, size = $10; }`);
      expect(cfg.memory[0].start.op).not.toBe('num');
      expect(() => areaGeometry(cfg.memory[0]))
          .toThrow(/start is not constant \(__ONCE_RUN__ is not defined\)/);
    });

    it('should resolve a MEMORY expression against a SYMBOLS entry', function() {
      // Example found in ca65 linker script for apple2/atari2600 target
      const cfg = parseLinkerConfig(`
        SYMBOLS { __STACKSIZE__: type = weak, value = $0010; }
        MEMORY {
          RAM: file = "", start = $0080, size = $0080 - __STACKSIZE__, define = yes;
          ROM: file = %O, start = $F000, size = $1000, fill = yes, fillval = $FF;
        }
      `);
      const syms = configSymbols(cfg);
      expect(syms.get('__STACKSIZE__')).toBe(0x10);
      expect(areaGeometry(cfg.memory[0], syms)).toEqual([0x80, 0x70]);
      expect(areaGeometry(cfg.memory[1], syms)).toEqual([0xf000, 0x1000]);
    });

    it('should let a SYMBOLS entry reference an earlier one', function() {
      const cfg = parseLinkerConfig(`
        SYMBOLS {
          __BASE__: type = export, value = $0200;
          __TOP__:  type = export, value = __BASE__ + $100;
        }
      `);
      expect([...configSymbols(cfg)]).toEqual([
        ['__BASE__', 0x200], ['__TOP__', 0x300],
      ]);
    });

    it('should let an object export beat a weak symbol but not an export', function() {
      const cfg = parseLinkerConfig(`
        SYMBOLS {
          __WEAK__:   type = weak,   value = $1111;
          __STRONG__: type = export, value = $2222;
        }
      `);
      const syms = configSymbols(cfg, new Set(['__WEAK__', '__STRONG__']));
      expect(syms.has('__WEAK__')).toBe(false);
      expect(syms.get('__STRONG__')).toBe(0x2222);
    });

    it('should let a `-D` define override a SYMBOLS value', function() {
      const cfg = parseLinkerConfig(`
        SYMBOLS {
          __STACKSIZE__: type = weak,   value = $0010;
          __STRONG__:    type = export, value = $2222;
          __DERIVED__:   type = export, value = __STACKSIZE__ + 1;
        }
      `);
      const defines = linkerDefines([{name: '__STACKSIZE__', value: '$400'},
                                     {name: '__STRONG__', value: '17'}]);
      const syms = configSymbols(cfg, new Set(), defines);
      expect(syms.get('__STACKSIZE__')).toBe(0x400);
      expect(syms.get('__STRONG__')).toBe(17);
      // Later entries see the overridden value, not the config's own.
      expect(syms.get('__DERIVED__')).toBe(0x401);
    });

    it('should let an object export still beat a `-D` on a weak symbol', function() {
      const cfg = parseLinkerConfig(
          `SYMBOLS { __STACKSIZE__: type = weak, value = $0010; }`);
      const defines = linkerDefines([{name: '__STACKSIZE__', value: '$400'}]);
      expect(configSymbols(cfg, new Set(['__STACKSIZE__']), defines).size).toBe(0);
    });

    it('should not invent a symbol for a `-D` the config never names', function() {
      const cfg = parseLinkerConfig(`SYMBOLS { A: type = export, value = 1; }`);
      const defines = linkerDefines([{name: 'DEBUG', value: '1'}]);
      expect([...configSymbols(cfg, new Set(), defines)]).toEqual([['A', 1]]);
    });

    it('should read `-D` values in every ld65 number spelling', function() {
      expect([...linkerDefines([
        {name: 'DEC', value: '42'},
        {name: 'HEX', value: '$2a'},
        {name: 'BIN', value: '%101010'},
        {name: 'SPACED', value: ' 42 '},
      ])]).toEqual([['DEC', 42], ['HEX', 42], ['BIN', 42], ['SPACED', 42]]);
    });

    it('should skip a `-D` value the linker cannot read as a number', function() {
      // These are meaningful on the assembler side, where the same list goes.
      expect([...linkerDefines([
        {name: 'STR', value: '"hello"'},
        {name: 'EXPR', value: '3+5'},
        {name: 'EMPTY', value: ''},
        {name: 'SYM', value: 'OTHER'},
      ])]).toEqual([]);
    });

    it('should let the last `-D` of a name win', function() {
      expect([...linkerDefines([{name: 'A', value: '1'}, {name: 'A', value: '2'}])])
          .toEqual([['A', 2]]);
    });

    it('should contribute no value for an import', function() {
      const cfg = parseLinkerConfig(`SYMBOLS { __EXEHDR__: type = import; }`);
      expect(cfg.symbols).toEqual([{name: '__EXEHDR__', type: 'import'}]);
      expect([...configSymbols(cfg)]).toEqual([]);
    });

    it('should reject a valueless export and a valued import', function() {
      expectSourceError(`SYMBOLS { A: type = export; }`,
                        /Symbol 'A' of type 'export' needs a 'value'/, 1);
      expectSourceError(`SYMBOLS { A: type = import, value = 1; }`,
                        /Imported symbol 'A' must not have a value/, 1);
      expectSourceError(`SYMBOLS { A: value = 1; }`,
                        /Symbol 'A' needs a 'type'/, 1);
    });

    it('should let an area size reference that area own start define', function() {
      // ld65 defines `__NAME_START__` between resolving `start` and `size`
      // precisely so that the size expression may reference it.
      const cfg = parseLinkerConfig(`
        MEMORY {
          A: start = $8000, size = $C000 - __A_START__, define = yes;
        }
      `);
      const syms = configSymbols(cfg);
      const start = resolveCfgExpr(cfg.memory[0].start, syms, 'start');
      expect(start).toBe(0x8000);
      expect(() => resolveCfgExpr(cfg.memory[0].size, syms, 'size'))
          .toThrow(/__A_START__ is not defined/);
      syms.set('__A_START__', start);
      expect(resolveCfgExpr(cfg.memory[0].size, syms, 'size')).toBe(0x4000);
    });

    it('should defer a layout-derived reference to lowering', function() {
      // Example from apple2.cfg
      // `__ONCE_RUN__` is only known after placing MAIN's segments, and
      // MAIN is declared before BSS, so no extra pass is needed.
      const cfg = parseLinkerConfig(`
        MEMORY {
          MAIN: start = $0803, size = $8DFD;
          BSS:  start = __ONCE_RUN__, size = $9600 - __ONCE_RUN__;
        }
        SEGMENTS {
          ONCE: load = MAIN, type = ro, define = yes;
          BSS:  load = BSS,  type = bss;
        }
      `);
      const syms = configSymbols(cfg);
      expect(resolveCfgExpr(cfg.memory[0].start, syms, 'start')).toBe(0x803);
      syms.set('__ONCE_RUN__', 0x9000);
      expect(areaGeometry(cfg.memory[1], syms)).toEqual([0x9000, 0x600]);
    });

    it('should substitute %S when a start address is supplied', function() {
      const src = `MEMORY { HEADER: start = %S - $003A, size = $003A; }`;
      expect(areaGeometry(parseLinkerConfig(src, 'x.cfg',
                                           {startAddr: 0x0803}).memory[0]))
          .toEqual([0x0803 - 0x3a, 0x3a]);
      const cfg = parseLinkerConfig(src);
      expect(() => areaGeometry(cfg.memory[0]))
          .toThrow(/start is not constant \(%S is not defined\)/);
    });

    it('should reject a malformed number', function() {
      expectSourceError(`MEMORY { A: start = 0x10, size = $10; }`,
                        /Bad decimal number/, 1);
    });
  });

  describe('lexical inversions vs. ca65', function() {
    it('should treat ; as a statement terminator, not a comment', function() {
      // In ca65 everything after the first `;` here would be a comment.
      const cfg = parseLinkerConfig(
          `MEMORY { A: start = $0, size = $10; B: start = $10, size = $10; }`);
      expect(cfg.memory.map(a => a.name)).toEqual(['A', 'B']);
    });

    it('should skip # comments and blank lines', function() {
      // The shape of nsf.cfg's MEMORY block, including its bare `#arrmem`.
      const cfg = parseLinkerConfig(`
        MEMORY {
          # bank configuration:
          # $8000-$9FFF: 8K fixed bank

          A: start = $8000, size = $2000;   # trailing comment

          # automatically allocate music data's memory areas
          #arrmem

          B: start = $A000, size = $2000;
        }
      `);
      expect(cfg.memory.map(a => a.name)).toEqual(['A', 'B']);
    });

    it('should skip // comments', function() {
      const cfg = parseLinkerConfig(`
        // leading comment
        MEMORY {
          A: start = $8000, size = $2000;   // trailing comment
        }
      `);
      expect(cfg.memory.map(a => a.name)).toEqual(['A']);
    });

    it('should lex tab-indented statements', function() {
      const cfg = parseLinkerConfig(
          'MEMORY {\n\tA:\tstart = $0,\tsize = $10;\n}\n');
      expect(cfg.memory.map(a => a.name)).toEqual(['A']);
    });

    it('should treat the comma between attributes as optional', function() {
      // The atari5200.cfg and apple2-hgr.cfg spellings; see `splitAttrs`.
      const cfg = parseLinkerConfig(`
        MEMORY {
          A: start = $0, size = $0014   fill = yes, fillval = $40;
        }
        SEGMENTS {
          S: load = A,   type = ro   start = $4000;
        }
      `);
      expect(cfg.memory[0]).toMatchObject({fill: true, fillval: 0x40});
      expect(cfg.segments[0]).toMatchObject({type: 'ro', start: 0x4000});
    });

    it('should reject a value where an attribute name belongs', function() {
      expectSourceError(`MEMORY {\n  A: $0, size = $10;\n}`,
                        /Expected an attribute name/, 2);
    });

    it('should accept %O bare and quoted, as a key and as a value', function() {
      const cfg = parseLinkerConfig(`
        FILES {
          %O: format = bin;
          "%O_header": format = bin;
        }
        MEMORY {
          A: start = $0, size = $10, file = %O;
          B: start = $0, size = $80, file = "%O_header";
        }
      `);
      expect(cfg.files.map(f => f.name)).toEqual(['%O', '%O_header']);
      expect(cfg.memory.map(a => a.file)).toEqual(['%O', '%O_header']);
    });
  });

  describe('blocks', function() {
    it('should parse SYMBOLS', function() {
      const cfg = parseLinkerConfig(`
        SYMBOLS {
          __STACKSIZE__: type = weak, value = $0800;
          _exported:     type = export, value = 1;
          _imported:     type = import;
        }
      `);
      expect(cfg.symbols.map(s => [s.name, s.type, value(s.value)])).toEqual([
        ['__STACKSIZE__', 'weak', 0x800],
        ['_exported', 'export', 1],
        ['_imported', 'import', undefined],
      ]);
    });

    it('should ignore FEATURES and FORMATS without throwing', function() {
      const cfg = parseLinkerConfig(`
        FEATURES {
          CONDES: segment = RODATA,
                  type = constructor,
                  label = __CONSTRUCTOR_TABLE__;
        }
        FORMATS { o65: export = _main; }
        MEMORY { A: start = $0, size = $10; }
      `);
      expect(cfg.memory.map(a => a.name)).toEqual(['A']);
    });

    it('should reject an unknown block', function() {
      expectSourceError(`NONSENSE { A: start = $0; }`,
                        /Unknown linker config block: NONSENSE/, 1);
    });

    it('should reject a block with no braces', function() {
      expectSourceError(`MEMORY`, /Expected '\{' after MEMORY/, 1);
    });
  });

  describe('malformed configs', function() {
    const cases: Array<[string, string, RegExp]> = [
      ['a missing statement terminator',
       `MEMORY {\n  A: start = $0, size = $10\n}`, /Expected ';'/],
      ['an unterminated block',
       `MEMORY {\n  A: start = $0, size = $10;`, /Missing close curly/],
      ['an absent size',
       `MEMORY {\n  A: start = $0;\n}`, /Missing required attribute 'size'/],
      ['a bad area type',
       `MEMORY {\n  A: start = $0, size = $10, type = weird;\n}`,
       /'type' must be one of: ro, rw$/],
      ['a segment type used on an area',
       `MEMORY {\n  A: start = $0, size = $10, type = bss;\n}`,
       /'type' must be one of: ro, rw$/],
      ['a bad segment type',
       `MEMORY {\n  A: start = $0, size = $10;\n}\n` +
       `SEGMENTS {\n  S: load = A, type = weird;\n}`,
       /'type' must be one of: ro, rw, bss, zp, overwrite/],
      ['a bad boolean',
       `MEMORY {\n  A: start = $0, size = $10, fill = maybe;\n}`,
       /'fill' must be one of/],
      ['an unknown attribute',
       `MEMORY {\n  A: start = $0, size = $10, frobnicate = yes;\n}`,
       /Unknown MEMORY attribute 'frobnicate'/],
      ['a duplicated attribute',
       `MEMORY {\n  A: start = $0, size = $10, size = $20;\n}`,
       /Duplicate attribute: size/],
      ['a missing value',
       `MEMORY {\n  A: start = $0, size = ;\n}`, /Missing value for 'size'/],
      ['a missing colon',
       `MEMORY {\n  A start = $0, size = $10;\n}`, /Expected :/],
      ['a segment loading from an undeclared area',
       `MEMORY {\n  A: start = $0, size = $10;\n}\nSEGMENTS {\n  S: load = NOPE;\n}`,
       /load = NOPE, which is not a MEMORY area/],
      ['a segment with neither load nor run',
       `MEMORY {\n  A: start = $0, size = $10;\n}\nSEGMENTS {\n  S: type = ro;\n}`,
       /needs at least one of 'load', 'run', 'mirror' or 'pool'/],
      ['a duplicated area',
       `MEMORY {\n  A: start = $0, size = $10;\n  A: start = $20, size = $10;\n}`,
       /Duplicate MEMORY entry: A/],
      ['a duplicated segment',
       `MEMORY {\n  A: start = $0, size = $10;\n}\n` +
       `SEGMENTS {\n  S: load = A;\n  S: load = A;\n}`,
       /Duplicate SEGMENTS entry: S/],
    ];
    for (const [name, cfg, message] of cases) {
      it(`should reject ${name}`, function() {
        expectSourceError(cfg, message);
      });
    }

    it('should report the line the error is actually on', function() {
      expectSourceError(
          `MEMORY {\n  A: start = $0, size = $10;\n  B: start = $0;\n}`,
          /Missing required attribute 'size'/, 3);
    });
  });

  describe('run != load', function() {
    // The shape of TakuikaNinja/FDS-Mirroring-Test's fds.cfg: every byte lives
    // in one SIDE1A area, but the BIOS file loader copies each file to a
    // different runtime address.
    const FDS_CFG = `MEMORY {
    SIDE1A:   start = $0000, size = 65500, type = ro, file = %O, fill = yes, fillval = 0;
    PRG0:     start = $6000, size = $7FF6, type = rw, file = "";
    VEC1:     start = $DFF6, size = $000A, type = rw, file = "";
}
SEGMENTS {
    FILE0_HDR: load = SIDE1A, type = ro;
    FILE0_DAT: load = SIDE1A, run = PRG0, define = yes;
    FILE1_HDR: load = SIDE1A, type = ro;
    FILE1_DAT: load = SIDE1A, run = VEC1, define = yes;
}`;

    it('should parse an fds-shaped config in full', function() {
      const cfg = parseLinkerConfig(FDS_CFG);
      expect(cfg.memory.map(a => a.name)).toEqual(['SIDE1A', 'PRG0', 'VEC1']);
      expect(areaGeometry(cfg.memory[0])).toEqual([0, 65500]);
      expect(cfg.memory[0]).toMatchObject({
        type: 'ro', file: '%O', fill: true, fillval: 0,
      });
      // `file = ""` must become undefined, not a bucket named ''.
      expect(cfg.memory[1].file).toBeUndefined();
      expect(cfg.memory[2].file).toBeUndefined();
      expect(cfg.segments.map(s => [s.name, s.load, s.run])).toEqual([
        ['FILE0_HDR', 'SIDE1A', 'SIDE1A'],
        ['FILE0_DAT', 'SIDE1A', 'PRG0'],
        ['FILE1_HDR', 'SIDE1A', 'SIDE1A'],
        ['FILE1_DAT', 'SIDE1A', 'VEC1'],
      ]);
      // FILE0_DAT declares no type; it inherits SIDE1A's `ro`, not PRG0's `rw`.
      expect(cfg.segments[1]).toMatchObject({type: 'ro', define: true});
    });

    it('should default run to load and load to run', function() {
      const cfg = parseLinkerConfig(`
        MEMORY {
          A: start = $0000, size = $1000;
          B: start = $6000, size = $1000;
        }
        SEGMENTS {
          LOAD_ONLY: load = A;
          RUN_ONLY:  run  = B;
          BOTH:      load = A, run = B;
        }
      `);
      expect(cfg.segments.map(s => [s.load, s.run])).toEqual([
        ['A', 'A'], ['B', 'B'], ['A', 'B'],
      ]);
    });

    it('should parse the remaining ld65 segment attributes', function() {
      const cfg = parseLinkerConfig(`
        MEMORY { A: start = $0200, size = $1000; }
        SEGMENTS {
          DATA: load = A, type = rw, define = yes, offset = $0200;
          OVER: load = A, type = overwrite, start = $0400, fillval = $EA;
        }
      `);
      expect(cfg.segments[0]).toMatchObject({offset: 0x200, type: 'rw'});
      expect(cfg.segments[1])
          .toMatchObject({type: 'overwrite', start: 0x400, fillval: 0xea});
    });

    it('should accept BINARY as an alias for BIN', function() {
      const cfg = parseLinkerConfig(`FILES { %O: format = binary; }`);
      expect(cfg.files).toEqual([{name: '%O', format: 'bin'}]);
    });

    it('should parse align_load separately from align', function() {
      const cfg = parseLinkerConfig(`
        MEMORY {
          A: start = $0000, size = $1000;
          B: start = $6000, size = $1000;
        }
        SEGMENTS { S: load = A, run = B, align = 64, align_load = 16; }
      `);
      expect(cfg.segments[0]).toMatchObject({align: 64, alignLoad: 16});
    });
  });
});

describe('lowerLinkerConfig', function() {

  function lower(cfg: string) {
    return lowerLinkerConfig(parseLinkerConfig(cfg, 'test.cfg'));
  }

  it('should lower a geometry expression against a `-D` override', function() {
    const cfg = parseLinkerConfig(`
      SYMBOLS { __STACKSIZE__: type = weak, value = $0010; }
      MEMORY { RAM: start = $0080, size = $0080 - __STACKSIZE__; }
    `, 'test.cfg');
    expect(lowerLinkerConfig(cfg, new Set(),
                             linkerDefines([{name: '__STACKSIZE__', value: '$40'}])))
        .toEqual([{name: 'RAM', memory: 0x80, size: 0x40}]);
  });

  it('should lower an area into a free-standing segment', function() {
    expect(lower(`MEMORY {
      RAM: start = $0300, size = $0500;
      PRG: start = $8000, size = $4000, file = %O, fill = yes, fillval = $FF,
           bank = 1, define = yes;
      CHR: start = $0000, size = $2000, file = "chr.bin";
    }`)).toEqual([
      {name: 'RAM', memory: 0x300, size: 0x500},
      {name: 'PRG', memory: 0x8000, size: 0x4000, bank: 1, out: '%O',
       fill: 0xff, define: true},
      {name: 'CHR', memory: 0, size: 0x2000, out: 'chr.bin'},
    ]);
  });

  it('should lower a segment into an unmapped segment', function() {
    expect(lower(`
      MEMORY {
        PRG: start = $8000, size = $4000, file = %O;
        RAM: start = $0300, size = $0500;
      }
      SEGMENTS {
        CODE:     load = PRG, align = $100;
        BOOT:     load = PRG, run = RAM, align_load = 16, fillval = $EA;
        ZEROPAGE: load = RAM, type = zp;
        BSS:      load = RAM, type = bss, optional = yes, define = yes;
        VECTORS:  load = PRG, start = $BFFA;
        TABLE:    load = PRG, offset = $200;
      }`).slice(2)).toEqual([
      {name: 'CODE', load: 'PRG', run: 'PRG', align: 0x100},
      {name: 'BOOT', load: 'PRG', run: 'RAM', alignLoad: 16, fill: 0xea},
      {name: 'ZEROPAGE', load: 'RAM', run: 'RAM', bss: true, addressing: 1},
      {name: 'BSS', load: 'RAM', run: 'RAM', bss: true, define: true,
       optional: true},
      {name: 'VECTORS', load: 'PRG', run: 'PRG', memory: 0xbffa},
      // `offset` is relative to the run area, unlike `start`.
      {name: 'TABLE', load: 'PRG', run: 'PRG', memory: 0x8200},
    ]);
  });

  describe('composite segments', function() {

    function expectRejected(cfg: string, message: RegExp) {
      let err: unknown;
      try {
        lower(cfg);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SourceError);
      expect((err as Error).message).toMatch(message);
    }

    const AREAS = `MEMORY {
      PRG1: start = $8000, size = $4000, file = %O, fill = yes, bank = 1;
      PRG2: start = $8000, size = $4000, file = %O, fill = yes, bank = 2;
    }`;

    it('should lower a mirror composite', function() {
      expect(lower(`${AREAS}
        SEGMENTS { COMMON: mirror = {PRG1, PRG2}; }`).slice(2))
          .toEqual([{name: 'COMMON', mirror: ['PRG1', 'PRG2']}]);
    });

    it('should lower a pool composite', function() {
      expect(lower(`${AREAS}
        SEGMENTS { MUSIC: pool = {PRG1, PRG2}; }`).slice(2))
          .toEqual([{name: 'MUSIC', pool: ['PRG1', 'PRG2']}]);
    });

    // `splitAttrs` drops depth-0 commas, but the braced list arrives as one
    // pre-grouped token so its commas survive. Both spellings must agree.
    it('should accept a comma-less member list', function() {
      expect(lower(`${AREAS}
        SEGMENTS { COMMON: mirror = {PRG1 PRG2}; }`).slice(2))
          .toEqual([{name: 'COMMON', mirror: ['PRG1', 'PRG2']}]);
    });

    it('should still reject duplicate attributes', function() {
      expectRejected(`${AREAS}
        SEGMENTS { COMMON: mirror = {PRG1, PRG2}, mirror = {PRG1, PRG2}; }`,
                     /Duplicate attribute/i);
    });

    it('should reject an composite named after a memory area', function() {
      expectRejected(`${AREAS}
        SEGMENTS { PRG1: mirror = {PRG1, PRG2}; }`, /area|name/i);
    });

    it('should reject an unknown member', function() {
      expectRejected(`${AREAS}
        SEGMENTS { COMMON: mirror = {PRG1, NOPE}; }`, /NOPE/);
    });

    it('should reject mapping attributes alongside an composite', function() {
      expectRejected(`${AREAS}
        SEGMENTS { COMMON: mirror = {PRG1, PRG2}, run = PRG1; }`, /mirror|run/i);
      expectRejected(`${AREAS}
        SEGMENTS { COMMON: mirror = {PRG1, PRG2}, load = PRG1; }`,
                     /mirror|load/i);
      expectRejected(`${AREAS}
        SEGMENTS { COMMON: mirror = {PRG1, PRG2}, start = $9000; }`,
                     /mirror|start/i);
    });

    it('should reject both mirror and pool on one entry', function() {
      expectRejected(`${AREAS}
        SEGMENTS { COMMON: mirror = {PRG1, PRG2}, pool = {PRG1, PRG2}; }`,
                     /mirror|pool/i);
    });

    it('should reject a single-member or empty list', function() {
      expectRejected(`${AREAS}
        SEGMENTS { COMMON: mirror = {PRG1}; }`, /at least two|two or more|single/i);
      expectRejected(`${AREAS}
        SEGMENTS { COMMON: mirror = {}; }`, /empty|at least two|two or more/i);
    });

    it('should require braces around the member list', function() {
      expectRejected(`${AREAS}
        SEGMENTS { COMMON: mirror = PRG1; }`, /list|brace/i);
    });

    // `optional` survives lowering here exactly like it does on any other
    // segment; the linker is what drops it when nothing references it.
    it('should carry optional through to the lowered composite', function() {
      expect(lower(`${AREAS}
        SEGMENTS { COMMON: mirror = {PRG1, PRG2}, optional = yes; }`).slice(2))
          .toEqual([{name: 'COMMON', mirror: ['PRG1', 'PRG2'], optional: true}]);
    });
  });

  describe('a segment sharing its area\'s name', function() {

    function expectRejected(cfg: string, message: RegExp) {
      let err: unknown;
      try {
        lower(cfg);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(SourceError);
      expect((err as Error).message).toMatch(message);
    }

    it('should collapse into the area', function() {
      // nrom.cfg declares both, and the segment is just the area's contents.
      expect(lower(`
        MEMORY {
          ZEROPAGE: start = $00,   size = $100;
          RAM:      start = $0300, size = $500;
        }
        SEGMENTS {
          ZEROPAGE: load = ZEROPAGE, type = zp;
          BSS:      load = RAM,      type = bss, align = $100;
          RAM:      load = RAM,      type = bss, start = $0300;
        }`)).toEqual([
        {name: 'ZEROPAGE', memory: 0, size: 0x100, bss: true, addressing: 1},
        {name: 'RAM', memory: 0x300, size: 0x500, bss: true},
        {name: 'BSS', load: 'RAM', run: 'RAM', bss: true, align: 0x100},
      ]);
    });

    it('should keep the area\'s place in the layout', function() {
      // The area's declaration order is the order its file is written in, so
      // the merged segment has to stay where the area was.
      expect(lower(`
        MEMORY {
          HDR: start = $0000, size = $10,   file = %O;
          PRG: start = $8000, size = $4000, file = %O;
        }
        SEGMENTS {
          CODE: load = PRG;
          HDR:  load = HDR;
        }`).map(s => s.name)).toEqual(['HDR', 'PRG', 'CODE']);
    });

    it('should reject a segment that loads somewhere else', function() {
      expectRejected(`
        MEMORY {
          A: start = $0000, size = $10;
          B: start = $8000, size = $10;
        }
        SEGMENTS { A: load = B; }`,
        /Segment 'A' shares its name with a MEMORY area but does not load/);
    });

    it('should reject a segment that runs somewhere else', function() {
      expectRejected(`
        MEMORY {
          A: start = $0000, size = $10;
          B: start = $8000, size = $10;
        }
        SEGMENTS { A: load = A, run = B; }`,
        /Segment 'A' shares its name with a MEMORY area but does not load/);
    });

    it('should start where the segment says, inside the area', function() {
      expect(lower(`
        MEMORY { A: start = $8000, size = $100; }
        SEGMENTS { A: load = A, start = $8010; }`))
          .toEqual([{name: 'A', memory: 0x8010, size: 0xf0}]);
    });

    it('should round the merged start up to the segment\'s alignment', function() {
      expect(lower(`
        MEMORY { A: start = $8010, size = $100; }
        SEGMENTS { A: load = A, align = $100; }`))
          .toEqual([{name: 'A', memory: 0x8100, size: 0x10}]);
    });

    it('should reject a start outside the area', function() {
      expectRejected(`
        MEMORY { A: start = $8000, size = $100; }
        SEGMENTS { A: load = A, start = $9000; }`,
        /Segment 'A' starts at \$9000, which is outside the MEMORY area/);
    });
  });

  it('should resolve config symbols in area expressions', function() {
    expect(lower(`
      SYMBOLS { __SIZE__: type = weak, value = $2000; }
      MEMORY { PRG: start = $10000 - __SIZE__, size = __SIZE__; }`))
        .toEqual([{name: 'PRG', memory: 0xe000, size: 0x2000}]);
  });

  it('should let an object file override a weak config symbol', function() {
    const cfg = parseLinkerConfig(`
      SYMBOLS {
        __STACK__: type = weak, value = $100;
        __TOP__:   type = export, value = $200;
      }
      MEMORY { RAM: start = $200 - __STACK__, size = __TOP__; }`);
    // The object file's own definition wins, which leaves nothing for the
    // area's start to resolve against.
    expect(() => lowerLinkerConfig(cfg, new Set(['__STACK__'])))
        .toThrow(/MEMORY area 'RAM' start is not constant \(__STACK__/);
  });
});

