
// SPDX-License-Identifier: MPL-2.0

import {type Match} from './buffer.ts';
import {type SourceInfo} from './error.ts';
import {type LintLevel} from './options.ts';

/**
 * Lints are constructs that assemble cleanly but are almost certainly not what
 * the author meant. They are never errors and never fail a build.
 *
 * A lint can be silenced in the source with a comment pragma:
 *
 *     ; js65-lint-disable-next-line bare-number-operand
 *       lda 5
 *       lda 5   ; js65-lint-disable-line bare-number-operand
 */

export interface LintRule {
  /** Level reported when the project has not configured this rule. */
  level: LintLevel;
  /** One-line summary, shown by `js65 --help`. */
  description: string;
}

export const LINT_RULES: ReadonlyMap<string, LintRule> = new Map([
  ['bare-number-operand', {
    level: 'warning',
    description: 'a lone decimal/binary literal used as an address, e.g. `lda 5`',
  }],
  ['suspicious-address-expr', {
    level: 'warning',
    description: 'a lo/hi byte expression used as an address, e.g. `lda <label`',
  }],
  ['endproc-no-terminator', {
    level: 'warning',
    description: '`.endproc` whose last instruction falls through',
  }],
  ['jsr-rts-tail-call', {
    level: 'info',
    description: '`jsr` immediately followed by `rts`, which could be a `jmp`',
  }],
  ['jmp-fallthrough', {
    level: 'info',
    description: '`jmp` to the label defined on the very next line',
  }],
] as const);

/** Matches a suppression comment, capturing `next-` (if any) and the rule ids. */
const RE_PRAGMA = /^;+\s*js65-lint-disable-(next-)?line\b[\s,]*(.*)$/;

export class LintPragmas {
  /** `file:line` -> suppressed rule ids on that line. */
  private readonly suppressions = new Map<string, Set<string>>();

  /** Records a pragma if `match` is one; ordinary comments are ignored. */
  record(file: string, match: Match): void {
    const pragma = RE_PRAGMA.exec(match[0]);
    if (!pragma) return;
    const rules = pragma[2].trim().split(/[\s,]+/).filter(r => r);
    if (!rules.length) return;
    // `disable-line` applies to the comment's own line, `disable-next-line` to
    // the one after it.
    const line = match.line + (pragma[1] ? 1 : 0);
    const key = `${file}:${line}`;
    let set = this.suppressions.get(key);
    if (!set) this.suppressions.set(key, set = new Set());
    for (const rule of rules) set.add(rule);
  }

  suppressed(rule: string, source?: SourceInfo): boolean {
    for (let s = source; s; s = s.parent) {
      const set = this.suppressions.get(`${s.file}:${s.line}`);
      if (set?.has(rule)) return true;
    }
    return false;
  }
}
