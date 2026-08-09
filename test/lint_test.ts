
// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';
import {LINT_RULES, LintPragmas} from '../src/lint.ts';
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
