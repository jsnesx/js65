
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {type AssemblerMessage} from '../src/error.ts';
import {compile, type AssemblyInput} from '../src/libassembler.ts';
import {LINT_RULES, LintPragmas} from '../src/lint.ts';
import {type LintOptions} from '../src/options.ts';
import {Tokenizer} from '../src/tokenizer.ts';

/** Collects the pragmas in `src` the way the assembler's tokenizer would. */
async function pragmasOf(src: string, file = 'input.s'): Promise<LintPragmas> {
  const lintPragmas = new LintPragmas();
  const tokenizer = new Tokenizer(src, file, {lintPragmas});
  while (await tokenizer.next()) { /* drain */ }
  return lintPragmas;
}

function at(line: number, file = 'input.s') {
  return {file, line, column: 0};
}

/**
 * Assembles a snippet that is expected to succeed and returns just the lint
 * messages - the ones carrying a rule id.
 */
async function lints(body: string, lint?: LintOptions): Promise<AssemblerMessage[]> {
  const code = `.segment "CODE" :bank $00 :size $8000 :mem $8000 :off $0000\n.org $8000\n${body}`;
  const result = await compile(
      [{type: 'source', code, name: 'test.s'} as AssemblyInput], {lint});
  if (!result.success) throw new Error(JSON.stringify(result.messages));
  return result.messages.filter(m => m.code);
}

/** The rule ids reported for `body`, in order. */
async function lintCodes(body: string, lint?: LintOptions): Promise<string[]> {
  return (await lints(body, lint)).map(m => m.code!);
}

describe('LintPragmas', function() {
  it('should suppress the line after disable-next-line', async function() {
    const p = await pragmasOf(`
      ; js65-lint-disable-next-line bare-number-operand
      lda 5
    `);
    expect(p.suppressed('bare-number-operand', at(3))).toBe(true);
    // Not the comment's own line, nor the one after the suppressed one.
    expect(p.suppressed('bare-number-operand', at(2))).toBe(false);
    expect(p.suppressed('bare-number-operand', at(4))).toBe(false);
  });

  it('should suppress the comment line itself for disable-line', async function() {
    const p = await pragmasOf(`
      lda 5 ; js65-lint-disable-line bare-number-operand
      lda 5
    `);
    expect(p.suppressed('bare-number-operand', at(2))).toBe(true);
    expect(p.suppressed('bare-number-operand', at(3))).toBe(false);
  });

  it('should suppress only the named rule', async function() {
    const p = await pragmasOf(`
      lda 5 ; js65-lint-disable-line bare-number-operand
    `);
    expect(p.suppressed('suspicious-address-expr', at(2))).toBe(false);
  });

  it('should accept several rule ids on one comment', async function() {
    const p = await pragmasOf(`
      lda 5 ; js65-lint-disable-line bare-number-operand suspicious-address-expr
      lda 5 ; js65-lint-disable-line bare-number-operand, jmp-fallthrough
    `);
    expect(p.suppressed('bare-number-operand', at(2))).toBe(true);
    expect(p.suppressed('suspicious-address-expr', at(2))).toBe(true);
    expect(p.suppressed('bare-number-operand', at(3))).toBe(true);
    expect(p.suppressed('jmp-fallthrough', at(3))).toBe(true);
  });

  it('should merge pragmas landing on the same line', async function() {
    const p = await pragmasOf(`
      ; js65-lint-disable-next-line bare-number-operand
      lda 5 ; js65-lint-disable-line suspicious-address-expr
    `);
    expect(p.suppressed('bare-number-operand', at(3))).toBe(true);
    expect(p.suppressed('suspicious-address-expr', at(3))).toBe(true);
  });

  it('should ignore ordinary comments', async function() {
    const p = await pragmasOf(`
      ; just a comment about bare-number-operand
      ;; js65-lint-disabled bare-number-operand
      lda 5
    `);
    expect(p.suppressed('bare-number-operand', at(3))).toBe(false);
    expect(p.suppressed('bare-number-operand', at(4))).toBe(false);
  });

  it('should ignore a pragma naming no rules', async function() {
    const p = await pragmasOf(`
      ; js65-lint-disable-next-line
      lda 5
    `);
    expect(p.suppressed('bare-number-operand', at(3))).toBe(false);
  });

  it('should accept a doubled comment marker', async function() {
    const p = await pragmasOf(`
      ;; js65-lint-disable-next-line bare-number-operand
      lda 5
    `);
    expect(p.suppressed('bare-number-operand', at(3))).toBe(true);
  });

  it('should key suppressions by file', async function() {
    const p = await pragmasOf(`
      lda 5 ; js65-lint-disable-line bare-number-operand
    `, 'other.s');
    expect(p.suppressed('bare-number-operand', at(2, 'other.s'))).toBe(true);
    expect(p.suppressed('bare-number-operand', at(2, 'input.s'))).toBe(false);
  });

  it('should honor a suppression anywhere up the expansion stack', async function() {
    const p = await pragmasOf(`
      lda 5 ; js65-lint-disable-line bare-number-operand
    `);
    // A lint raised inside a macro body, expanded from the suppressed line.
    const inMacro = {file: 'macro.s', line: 7, column: 2, parent: at(2)};
    expect(p.suppressed('bare-number-operand', inMacro)).toBe(true);
    expect(p.suppressed('bare-number-operand', {...inMacro, parent: at(3)}))
        .toBe(false);
  });

  it('should not suppress anything without a source', async function() {
    const p = await pragmasOf('; js65-lint-disable-line bare-number-operand\n');
    expect(p.suppressed('bare-number-operand', undefined)).toBe(false);
  });
});

describe('bare-number-operand', function() {
  it('should fire on a lone decimal or binary address', async function() {
    expect(await lintCodes('lda 5')).toEqual(['bare-number-operand']);
    expect(await lintCodes('lda %101')).toEqual(['bare-number-operand']);
  });

  it('should fire on every addressing mode but immediate', async function() {
    expect(await lintCodes('lda 5,x')).toEqual(['bare-number-operand']);
    expect(await lintCodes('lda 5,y')).toEqual(['bare-number-operand']);
    expect(await lintCodes('lda (5),y')).toEqual(['bare-number-operand']);
    expect(await lintCodes('lda (5,x)')).toEqual(['bare-number-operand']);
    expect(await lintCodes('jmp (5)')).toEqual(['bare-number-operand']);
    expect(await lintCodes('sta 5')).toEqual(['bare-number-operand']);
    expect(await lintCodes('inc 5')).toEqual(['bare-number-operand']);
    expect(await lintCodes('jsr 5')).toEqual(['bare-number-operand']);
  });

  it('should stay quiet for hex, immediates and expressions', async function() {
    expect(await lintCodes('lda $05')).toEqual([]);
    expect(await lintCodes('lda #5')).toEqual([]);
    expect(await lintCodes('lda #%101')).toEqual([]);
    expect(await lintCodes('lda 2+3')).toEqual([]);
    expect(await lintCodes('lda ($05),y')).toEqual([]);
    expect(await lintCodes('foo = 5\n  lda foo')).toEqual([]);
    expect(await lintCodes('nop')).toEqual([]);
    expect(await lintCodes('asl a')).toEqual([]);
  });

  it('should stay quiet when the address size is spelled out', async function() {
    // `z:`/`a:` say the operand is an address in the assembler's own syntax,
    // which is the acknowledgement this rule is asking for.
    expect(await lintCodes('lda z:5')).toEqual([]);
    expect(await lintCodes('lda a:5')).toEqual([]);
    expect(await lintCodes('sta z:5')).toEqual([]);
    expect(await lintCodes('lda a:5,x')).toEqual([]);
    expect(await lintCodes('lda (z:5),y')).toEqual([]);
    expect(await lintCodes('lda (z:5,x)')).toEqual([]);
  });

  it('should report at warning level against the literal', async function() {
    const [msg] = await lints('  lda 5');
    expect(msg.level).toBe('warning');
    expect(msg.code).toBe('bare-number-operand');
    expect(msg.source).toMatchObject({file: 'test.s', line: 3, column: 6});
    expect(msg.message).toContain('`lda 5` uses 5 as an address');
    expect(msg.message).toContain('`lda #5`');
    expect(msg.message).toContain('`$05`');
    expect(msg.message).toContain('`lda z:5`');
  });

  it('should suggest the address size that matches the literal', async function() {
    // The suggestion has to name a size the value actually fits in, and keep
    // the rest of the operand as written.
    expect((await lints('lda 300'))[0].message).toContain('`lda a:300`');
    expect((await lints('lda (5),y'))[0].message).toContain('`lda (z:5),y`');
    expect((await lints('lda 5,x'))[0].message).toContain('`lda z:5,x`');
  });

  it('should not offer the immediate for a mnemonic without one', async function() {
    const [msg] = await lints('sta 5');
    expect(msg.message).toContain('`sta 5` uses 5 as an address');
    expect(msg.message).not.toContain('immediate');
  });

  it('should be silenced by a pragma', async function() {
    expect(await lintCodes(
        '; js65-lint-disable-next-line bare-number-operand\n  lda 5')).toEqual([]);
    expect(await lintCodes(
        'lda 5 ; js65-lint-disable-line bare-number-operand')).toEqual([]);
    // The pragma only covers the line it names.
    expect(await lintCodes(
        '; js65-lint-disable-next-line bare-number-operand\n  lda 5\n  lda 6'))
        .toEqual(['bare-number-operand']);
  });

  it('should be silenced by configuration', async function() {
    expect(await lintCodes('lda 5', {rules: {'bare-number-operand': 'off'}}))
        .toEqual([]);
    expect(await lintCodes('lda 5', {enabled: false})).toEqual([]);
  });

  it('should honor a configured level', async function() {
    const [msg] = await lints('lda 5', {rules: {'bare-number-operand': 'info'}});
    expect(msg.level).toBe('info');
  });
});

describe('suspicious-address-expr', function() {
  // A label, not a constant: `<` of an *address* is what reads as a dropped
  // `#`. See the `ca65 parity` block below for the rest of that distinction.
  const FOO = 'foo:\n';
  // A zero page label, which ca65 exempts - `<zfoo` is the whole address.
  const ZP = '.segment "ZEROPAGE" :bank $00 :size $100 :mem $0000 :zeropage\n' +
      '.org $0000\nzfoo: .res 1\n.segment "CODE"\n.org $8000\n';

  it('should fire on a lo/hi byte used as an address', async function() {
    expect(await lintCodes(`${FOO}  lda <foo`))
        .toEqual(['suspicious-address-expr']);
    expect(await lintCodes(`${FOO}  lda >foo`))
        .toEqual(['suspicious-address-expr']);
  });

  it('should fire on a label it has not reached yet', async function() {
    // A forward reference is still an unresolved symbol at this point, which
    // is a different expression shape than a label already seen.
    expect(await lintCodes('  lda <foo\nfoo:\n  rts'))
        .toEqual(['suspicious-address-expr']);
  });

  it('should stay quiet for an immediate or a plain address', async function() {
    expect(await lintCodes(`${FOO}  lda #<foo`)).toEqual([]);
    expect(await lintCodes(`${FOO}  lda #>foo`)).toEqual([]);
    expect(await lintCodes(`${FOO}  lda foo`)).toEqual([]);
    // Only a leading lo/hi byte looks like a dropped `#`.
    expect(await lintCodes(`${FOO}  lda foo+<foo`)).toEqual([]);
  });

  it('should stay quiet for a zero page label', async function() {
    expect(await lintCodes(`${ZP}  lda <zfoo`)).toEqual([]);
  });

  it('should stay quiet for a mnemonic with no immediate', async function() {
    expect(await lintCodes(`${FOO}  sta <foo`)).toEqual([]);
  });

  it('should stay quiet when the address size is spelled out', async function() {
    expect(await lintCodes(`${FOO}  lda z:<foo`)).toEqual([]);
    expect(await lintCodes(`${FOO}  lda a:<foo`)).toEqual([]);
  });

  it('should report at warning level with the suggested fixes', async function() {
    const [msg] = await lints(`${FOO}  lda <foo`);
    expect(msg.level).toBe('warning');
    expect(msg.code).toBe('suspicious-address-expr');
    expect(msg.message).toContain('`lda <foo` takes the low byte');
    expect(msg.message).toContain('`lda #<foo`');
    expect(msg.message).toContain('`lda z:<foo`');
  });

  it('should be silenced by a pragma', async function() {
    expect(await lintCodes(
        `${FOO}  lda <foo ; js65-lint-disable-line suspicious-address-expr`))
        .toEqual([]);
    expect(await lintCodes(
        `${FOO}; js65-lint-disable-next-line suspicious-address-expr\n  lda <foo`))
        .toEqual([]);
  });

  it('should be silenced by configuration', async function() {
    expect(await lintCodes(`${FOO}  lda <foo`,
                           {rules: {'suspicious-address-expr': 'off'}})).toEqual([]);
    expect(await lintCodes(`${FOO}  lda <foo`, {enabled: false})).toEqual([]);
  });

  describe('ca65 parity', function() {
    it('should stay quiet for a byte of a constant', async function() {
      // ca65 folds `<CONST` to a literal before the check ever runs, so only
      // an address reaches it. js65 inlines defined constants the same way.
      expect(await lintCodes('foo = $1234\n  lda <foo')).toEqual([]);
      expect(await lintCodes('  lda <$1234')).toEqual([]);
      expect(await lintCodes('  lda <300')).toEqual([]);
    });

    it('should stay quiet unless the byte op is the whole expression',
       async function() {
         // Unary `<` binds tighter than `+` in both assemblers, so `<foo+1` is
         // `(<foo)+1` - an address expression, not a truncated one.
         expect(await lintCodes(`${FOO}  lda <foo+1`)).toEqual([]);
         // Explicit parens do make it a byte op, but of an expression rather
         // than of a symbol, which ca65 also declines to flag.
         expect(await lintCodes(`${FOO}  lda <(foo+1)`)).toEqual([]);
       });

    it('should stay quiet for indexed and indirect operands', async function() {
      // ca65 matches only its plain direct/absolute modes: `lda #<foo,x` is
      // not a thing, so no `#` can have gone missing.
      expect(await lintCodes(`${FOO}  lda <foo,x`)).toEqual([]);
      expect(await lintCodes(`${FOO}  lda <foo,y`)).toEqual([]);
      expect(await lintCodes(`${FOO}  lda (<foo),y`)).toEqual([]);
      expect(await lintCodes(`${FOO}  lda (<foo,x)`)).toEqual([]);
    });
  });
});

describe('preprocessor substitution', function() {
  // Both macro styles run before the assembler sees a line, so a named
  // constant arrives as a bare literal. Naming the constant is what
  // `bare-number-operand` asks for, so the expansion must not turn around and
  // fault the author for it - that rule only judges a literal written where it
  // stands. `suspicious-address-expr` needs no such care: it asks whether the
  // finished expression takes a byte of an address, which substitution does
  // not change either way.

  it('should not fire on a .define substituted into an address', async function() {
    expect(await lintCodes('.define foo 8\n  lda foo')).toEqual([]);
    expect(await lintCodes('.define foo 8\n  lda foo,x')).toEqual([]);
    expect(await lintCodes('.define foo 8\n  lda (foo),y')).toEqual([]);
    expect(await lintCodes('.define foo 8\n  sta foo')).toEqual([]);
    expect(await lintCodes('.define foo %00001000\n  lda foo')).toEqual([]);
  });

  it('should not fire on a macro parameter used as an address', async function() {
    expect(await lintCodes(
        '.macro load val\n  lda val\n.endmacro\n  load 8')).toEqual([]);
    expect(await lintCodes(
        '.macro load val\n  lda val,x\n.endmacro\n  load 8')).toEqual([]);
  });

  it('should not fire on a define holding a byte of a constant',
     async function() {
       // `<8` and `<$1234` are arithmetic on a value, whichever layer of
       // substitution wrote them.
       expect(await lintCodes('.define foo $1234\n  lda <foo')).toEqual([]);
       expect(await lintCodes('.define foo 8\n.define bar <foo\n  lda bar'))
           .toEqual([]);
     });

  it('should still fire on a literal written in a macro body', async function() {
    // Nothing was substituted here - the body really does say `lda 8`.
    expect(await lintCodes('.macro load\n  lda 8\n.endmacro\n  load'))
        .toEqual(['bare-number-operand']);
    expect(await lintCodes('.define load lda 8\n  load'))
        .toEqual(['bare-number-operand']);
  });

  it('should follow a lo/hi byte of a label through any substitution',
     async function() {
       // Unlike a bare literal, `<label` keeps naming an address no matter how
       // it was assembled out of macro pieces, and reads as a dropped `#` in
       // every one of these - as it does under ca65, which sees only the
       // finished expression.
       expect(await lintCodes(
           'foo:\n.macro load val\n  lda val\n.endmacro\n  load <foo'))
           .toEqual(['suspicious-address-expr']);
       expect(await lintCodes(
           'foo:\n.macro load val\n  lda <val\n.endmacro\n  load foo'))
           .toEqual(['suspicious-address-expr']);
       expect(await lintCodes('foo:\n.define bar <foo\n  lda bar'))
           .toEqual(['suspicious-address-expr']);
       expect(await lintCodes(
           'foo:\n.macro load\n  lda <foo\n.endmacro\n  load'))
           .toEqual(['suspicious-address-expr']);
     });

  it('should report a macro-body lint at the body, under the call site',
     async function() {
       const [msg] = await lints('.macro load\n  lda 8\n.endmacro\n  load');
       expect(msg.source).toMatchObject({file: 'test.s', line: 4});
       expect(msg.source!.parent).toMatchObject({file: 'test.s', line: 6});
     });
});

describe('endproc-no-terminator', function() {
  it('should fire when the last instruction falls through', async function() {
    expect(await lintCodes('.proc foo\n  lda #1\n.endproc'))
        .toEqual(['endproc-no-terminator']);
  });

  it('should stay quiet when control is transferred away', async function() {
    expect(await lintCodes('.proc foo\n  rts\n.endproc')).toEqual([]);
    expect(await lintCodes('.proc foo\n  rti\n.endproc')).toEqual([]);
    expect(await lintCodes('.proc foo\n  brk\n.endproc')).toEqual([]);
    expect(await lintCodes('.proc foo\n  jmp foo\n.endproc')).toEqual([]);
    expect(await lintCodes('.proc foo\n  jsr foo\n.endproc')).toEqual([]);
    // Every branch counts, picked up by its `rel` addressing mode.
    expect(await lintCodes('.proc foo\nloop:\n  bne loop\n.endproc')).toEqual([]);
    expect(await lintCodes('.proc foo\nloop:\n  bvc loop\n.endproc')).toEqual([]);
  });

  it('should judge the last instruction, not the last byte', async function() {
    expect(await lintCodes('.proc foo\n  rts\n  .byte 1,2,3\n.endproc'))
        .toEqual([]);
  });

  it('should stay quiet for a proc with no instructions', async function() {
    expect(await lintCodes('.proc foo\n  .byte 1,2,3\n.endproc')).toEqual([]);
    expect(await lintCodes('.proc foo\n.endproc')).toEqual([]);
  });

  it('should judge nested procs on their own instructions', async function() {
    // The inner proc terminates; the outer one still falls through.
    expect(await lintCodes(
        '.proc outer\n  lda #1\n  .proc inner\n    rts\n  .endproc\n.endproc'))
        .toEqual(['endproc-no-terminator']);
    // ...and an inner fall-through does not silence the outer `rts`.
    expect(await lintCodes(
        '.proc outer\n  .proc inner\n    lda #1\n  .endproc\n  rts\n.endproc'))
        .toEqual(['endproc-no-terminator']);
    expect(await lintCodes(
        '.proc outer\n  .proc inner\n    rts\n  .endproc\n  rts\n.endproc'))
        .toEqual([]);
  });

  it('should ignore .scope, which has no fall-through of its own',
     async function() {
    expect(await lintCodes('.scope foo\n  lda #1\n.endscope')).toEqual([]);
    expect(await lintCodes('.proc foo\n  .scope bar\n    rts\n  .endscope\n.endproc'))
        .toEqual([]);
  });

  it('should stay quiet when an assert vouches for the fall-through',
     async function() {
    // An `.assert` after the last instruction says the author knows where the
    // proc ends up and asked the assembler to check it.
    expect(await lintCodes(
        '.proc foo\n  lda #1\n  .assert * = next\n.endproc\nnext:\n  rts'))
        .toEqual([]);
    // ...but only when it comes after. An assert earlier in the proc says
    // nothing about the end.
    expect(await lintCodes(
        '.proc foo\n  .assert * = $8000\n  lda #1\n.endproc'))
        .toEqual(['endproc-no-terminator']);
    // The assert belongs to the innermost open proc.
    expect(await lintCodes(
        '.proc outer\n  lda #1\n  .proc inner\n    lda #2\n' +
        '    .assert * = $8004\n  .endproc\n.endproc'))
        .toEqual(['endproc-no-terminator']);
  });

  it('should stay quiet behind the FALLTHROUGH macro', async function() {
    expect(await lintCodes(
        '.macpack common\n.proc foo\n  lda #1\n  FALLTHROUGH next\n.endproc\n' +
        'next:\n  rts'))
        .toEqual([]);
  });

  it('should report at warning level against the .endproc', async function() {
    const [msg] = await lints('.proc foo\n  lda #1\n.endproc');
    expect(msg.level).toBe('warning');
    expect(msg.code).toBe('endproc-no-terminator');
    expect(msg.source).toMatchObject({file: 'test.s', line: 5});
    expect(msg.message).toContain('`.endproc` for `foo` ends with `lda #1`');
  });

  it('should be silenced by a pragma', async function() {
    expect(await lintCodes(
        '.proc foo\n  lda #1\n' +
        '; js65-lint-disable-next-line endproc-no-terminator\n.endproc'))
        .toEqual([]);
    expect(await lintCodes(
        '.proc foo\n  lda #1\n' +
        '.endproc ; js65-lint-disable-line endproc-no-terminator'))
        .toEqual([]);
  });

  it('should be silenced by configuration', async function() {
    const body = '.proc foo\n  lda #1\n.endproc';
    expect(await lintCodes(body, {rules: {'endproc-no-terminator': 'off'}}))
        .toEqual([]);
    expect(await lintCodes(body, {enabled: false})).toEqual([]);
  });
});

describe('jsr-rts-tail-call', function() {
  // Somewhere for the `jsr` to go, past everything the tests care about.
  const FOO = '\nfoo:\n  lda #1\n  rts';

  it('should fire on a jsr immediately followed by an rts', async function() {
    expect(await lintCodes(`  jsr foo\n  rts${FOO}`))
        .toEqual(['jsr-rts-tail-call']);
  });

  it('should fire once per pair', async function() {
    expect(await lintCodes(`  jsr foo\n  rts\n  jsr foo\n  rts${FOO}`))
        .toEqual(['jsr-rts-tail-call', 'jsr-rts-tail-call']);
  });

  it('should stay quiet when the previous instruction is not a jsr',
     async function() {
    expect(await lintCodes(`  jmp foo\n  rts${FOO}`)).toEqual([]);
    expect(await lintCodes(`  lda #1\n  rts${FOO}`)).toEqual([]);
    // Nothing precedes the very first instruction.
    expect(await lintCodes(`  rts${FOO}`)).toEqual([]);
  });

  it('should stay quiet when a label separates the pair', async function() {
    // Something may branch to `ret`, in which case the `rts` has to stay.
    expect(await lintCodes(`  jsr foo\nret:\n  rts${FOO}`)).toEqual([]);
    expect(await lintCodes(`  jsr foo\n@ret:\n  rts${FOO}`)).toEqual([]);
    expect(await lintCodes(`  jsr foo\n:\n  rts${FOO}`)).toEqual([]);
  });

  it('should stay quiet when a directive separates the pair', async function() {
    // Conservative: a directive can emit bytes or move the pc between the two.
    expect(await lintCodes(`  jsr foo\n  .byte 0\n  rts${FOO}`)).toEqual([]);
    expect(await lintCodes(`  jsr foo\n  .align 2\n  rts${FOO}`)).toEqual([]);
    expect(await lintCodes(`.proc bar\n  jsr foo\n.endproc\n  rts${FOO}`))
        .toEqual([]);
  });

  it('should stay quiet when something references the rts', async function() {
    // `:<rts` reaches back to it, `:>rts` reaches forward to it.
    expect(await lintCodes(`  jsr foo\n  rts\n  bne :<rts${FOO}`)).toEqual([]);
    expect(await lintCodes(`  bne :>rts\n  jsr foo\n  rts${FOO}`)).toEqual([]);
  });

  it('should still fire when a different rts is referenced', async function() {
    // The back reference claims the second `rts`, not the pair's own.
    expect(await lintCodes(`  jsr foo\n  rts\nbar:\n  rts\n  bne :<rts${FOO}`))
        .toEqual(['jsr-rts-tail-call']);
  });

  it('should report at info level against the jsr', async function() {
    const [msg] = await lints(`  jsr foo\n  rts${FOO}`);
    expect(msg.level).toBe('info');
    expect(msg.code).toBe('jsr-rts-tail-call');
    expect(msg.source).toMatchObject({file: 'test.s', line: 3, column: 2});
    expect(msg.message).toContain('`jsr foo` followed by `rts` is a tail call');
    expect(msg.message).toContain('`jmp foo`');
  });

  it('should offer a fix rewriting the jsr and dropping the rts line',
     async function() {
    const [msg] = await lints(`  jsr foo\n  rts${FOO}`);
    expect(msg.fix!.title).toBe('Replace `jsr foo` and `rts` with `jmp foo`');
    expect(msg.fix!.edits).toEqual([
      // Just the mnemonic, leaving the operand as written.
      {file: 'test.s', startLine: 3, startColumn: 2, endLine: 3, endColumn: 5,
       newText: 'jmp'},
      // The whole `rts` line, including its line break.
      {file: 'test.s', startLine: 4, startColumn: 0, endLine: 5, endColumn: 0,
       newText: ''},
    ]);
  });

  it('should keep the case of the mnemonic it replaces', async function() {
    const [msg] = await lints(`  JSR foo\n  RTS${FOO}`);
    expect(msg.fix!.edits[0].newText).toBe('JMP');
  });

  it('should report a macro-body pair without a fix', async function() {
    // The edits would land in the macro definition, where the `rts` is not
    // adjacent for any other call site.
    const [msg] = await lints(
        `.macro tail\n  jsr foo\n  rts\n.endmacro\n  tail${FOO}`);
    expect(msg.code).toBe('jsr-rts-tail-call');
    expect(msg.source).toMatchObject({file: 'test.s', line: 4});
    expect(msg.fix).toBeUndefined();
  });

  it('should be reported after the rules that fire as they are read',
     async function() {
    // This one can only be decided at the end of the module, so it lands last
    // no matter where in the source it sits.
    expect(await lintCodes(`  jsr foo\n  rts\n  lda 5${FOO}`))
        .toEqual(['bare-number-operand', 'jsr-rts-tail-call']);
  });

  it('should be silenced by a pragma on the jsr', async function() {
    expect(await lintCodes(
        `; js65-lint-disable-next-line jsr-rts-tail-call\n  jsr foo\n  rts${FOO}`))
        .toEqual([]);
    expect(await lintCodes(
        `  jsr foo ; js65-lint-disable-line jsr-rts-tail-call\n  rts${FOO}`))
        .toEqual([]);
  });

  it('should be silenced by configuration', async function() {
    const body = `  jsr foo\n  rts${FOO}`;
    expect(await lintCodes(body, {rules: {'jsr-rts-tail-call': 'off'}}))
        .toEqual([]);
    expect(await lintCodes(body, {enabled: false})).toEqual([]);
  });

  it('should honor a configured level', async function() {
    const [msg] = await lints(`  jsr foo\n  rts${FOO}`,
                              {rules: {'jsr-rts-tail-call': 'warning'}});
    expect(msg.level).toBe('warning');
  });
});

describe('jmp-fallthrough', function() {
  // Somewhere else for a jump that is not a fall-through to go.
  const FAR = '\nfar:\n  rts';

  it('should fire on a jmp to the label on the next line', async function() {
    expect(await lintCodes(`  jmp next\nnext:\n  rts`))
        .toEqual(['jmp-fallthrough']);
    expect(await lintCodes(`  jmp @next\n@next:\n  rts`))
        .toEqual(['jmp-fallthrough']);
  });

  it('should stay quiet when the jump goes somewhere else', async function() {
    expect(await lintCodes(`  jmp far\nnext:\n  rts${FAR}`)).toEqual([]);
    // The label is not what the instruction above jumps to, or it is not a
    // jump at all.
    expect(await lintCodes(`  jsr next\nnext:\n  rts`)).toEqual([]);
    expect(await lintCodes(`  lda #1\nnext:\n  rts`)).toEqual([]);
    expect(await lintCodes(`next:\n  rts`)).toEqual([]);
  });

  it('should stay quiet when the operand is not a bare symbol',
     async function() {
    // `next-1` and `(next)` land somewhere other than the next instruction.
    expect(await lintCodes(`  jmp next-1\nnext:\n  rts`)).toEqual([]);
    expect(await lintCodes(`  jmp (next)\nnext:\n  .word next`)).toEqual([]);
  });

  it('should stay quiet when something separates the pair', async function() {
    expect(await lintCodes(`  jmp next\n  nop\nnext:\n  rts`)).toEqual([]);
    expect(await lintCodes(`  jmp next\n  .byte 0\nnext:\n  rts`)).toEqual([]);
  });

  it('should stay quiet behind the FALLTHROUGH macro', async function() {
    expect(await lintCodes(
        `.macpack common\n  lda #1\n  FALLTHROUGH next\nnext:\n  rts`))
        .toEqual([]);
  });

  it('should report at info level against the jmp', async function() {
    const [msg] = await lints(`  jmp next\nnext:\n  rts`);
    expect(msg.level).toBe('info');
    expect(msg.code).toBe('jmp-fallthrough');
    expect(msg.source).toMatchObject({file: 'test.s', line: 3, column: 2});
    expect(msg.message)
        .toContain('`jmp next` jumps to the very next instruction');
    expect(msg.message).toContain('`FALLTHROUGH next`');
  });

  it('should offer a fix replacing just the mnemonic', async function() {
    const [msg] = await lints(`  jmp next\nnext:\n  rts`);
    expect(msg.fix!.title)
        .toBe('Replace `jmp next` with `FALLTHROUGH next`');
    expect(msg.fix!.edits).toEqual([
      {file: 'test.s', startLine: 3, startColumn: 2, endLine: 3, endColumn: 5,
       newText: 'FALLTHROUGH'},
    ]);
  });

  it('should report a macro-body jump without a fix', async function() {
    // The edit would land in the macro definition, where the label the call
    // site fell into is not even in scope.
    const [msg] = await lints(
        `.macro hop\n  jmp next\n.endmacro\n  hop\nnext:\n  rts`);
    expect(msg.code).toBe('jmp-fallthrough');
    expect(msg.source).toMatchObject({file: 'test.s', line: 4});
    expect(msg.fix).toBeUndefined();
  });

  it('should be silenced by a pragma on the jmp', async function() {
    expect(await lintCodes(
        `; js65-lint-disable-next-line jmp-fallthrough\n  jmp next\nnext:\n  rts`))
        .toEqual([]);
    expect(await lintCodes(
        `  jmp next ; js65-lint-disable-line jmp-fallthrough\nnext:\n  rts`))
        .toEqual([]);
  });

  it('should be silenced by configuration', async function() {
    const body = `  jmp next\nnext:\n  rts`;
    expect(await lintCodes(body, {rules: {'jmp-fallthrough': 'off'}}))
        .toEqual([]);
    expect(await lintCodes(body, {enabled: false})).toEqual([]);
  });

  it('should honor a configured level', async function() {
    const [msg] = await lints(`  jmp next\nnext:\n  rts`,
                              {rules: {'jmp-fallthrough': 'warning'}});
    expect(msg.level).toBe('warning');
  });
});

describe('LINT_RULES', function() {
  it('should describe every rule at a reportable level', function() {
    expect(LINT_RULES.size).toBe(5);
    for (const [id, rule] of LINT_RULES) {
      expect(id, `${id} id`).toMatch(/^[a-z][a-z-]*[a-z]$/);
      expect(['info', 'warning'], `${id} level`).toContain(rule.level);
      expect(rule.description.length, `${id} description`).toBeGreaterThan(0);
    }
  });
});
