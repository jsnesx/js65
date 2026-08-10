
// SPDX-License-Identifier: MPL-2.0

import type {Arg} from './assembler.ts';
import {type Match} from './buffer.ts';
import type {AddressingMode} from './cpu.ts';
import {type ErrorCollector, type MessageFix, type SourceInfo} from './error.ts';
import {type Expr} from './expr.ts';
import {type LintLevel, type LintOptions} from './options.ts';
import {type Token} from './token.ts';
import * as Tokens from './token.ts';

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

/** The opcode table for a single mnemonic, as `Cpu.op()` returns it. */
type Ops = {[mode in AddressingMode]?: number};

/**
 * Runs the lint rules. The assembler owns one of these and calls into it as it
 * walks the source; every rule reports through `report()`, which resolves the
 * configured level and honors suppression pragmas.
 */
export class Linter {
  constructor(private readonly errorCollector: ErrorCollector,
              private readonly opts: LintOptions = {},
              private readonly pragmas?: LintPragmas) {}

  private level(rule: string): LintLevel {
    if (this.opts.enabled === false) return 'off';
    return this.opts.rules?.[rule] ?? LINT_RULES.get(rule)?.level ?? 'off';
  }

  /** Reports a lint, unless it is configured off or suppressed at `source`. */
  report(rule: string, message: string, source?: SourceInfo, fix?: MessageFix): void {
    const level = this.level(rule);
    if (level === 'off') return;
    if (this.pragmas?.suppressed(rule, source)) return;
    this.errorCollector.add(level, message, source, fix ? {code: rule, fix} : {code: rule});
  }

  /**
   * Called for each instruction the assembler encounters, after the mnemonic is
   * known to be valid. `tokens` is the whole source line, absent when the
   * instruction came from the programmatic API rather than from source.
   */
  instruction(mnemonic: string, arg: Arg, ops: Ops, tokens?: Token[]): void {
    if (!tokens) return;
    const mode = arg[0];
    // Anything but an immediate is reading or writing an address, and an
    // address written as a bare decimal is almost always a slip.
    if (mode === 'imm' || mode === 'imp' || mode === 'acc') return;
    const operand = tokens.slice(1);
    if (!operand.length) return;
    if (hasAddrSize(operand)) return;
    const site = tokens[0].source;
    this.bareNumberOperand(mnemonic, ops, operand, site);
    this.suspiciousAddressExpr(mnemonic, mode, ops, arg[1], operand);
  }

  /** `lda 5`, `lda (5),y`, `sta 5` - a decimal or binary literal as an address. */
  private bareNumberOperand(mnemonic: string, ops: Ops, operand: Token[],
                            site?: SourceInfo): void {
    // Strip the operand down to just the number value
    const bare = operand.filter(t => !isSyntax(t));
    if (bare.length !== 1) return;
    const num = bare[0];
    if (num.token !== 'num' || (num.radix !== 10 && num.radix !== 2)) return;
    // For macros/define, check if the number got here through a replacement
    if (!sameOrigin(num.source, site)) return;

    const lit = render(num);
    const hex = hexLiteral(num.num);
    // The same operand with the address size spelled out, which is both a fix
    // and the documented way to keep the literal as written.
    const prefix = num.num > 0xff ? 'a:' : 'z:';
    const forced = operand.map(t => t === num ? prefix + lit : render(t)).join('');
    // `lda 5` reads as a missing `#`; `sta (5),y` cannot, so only offer the
    // immediate when the mnemonic actually has one.
    const immediate = 'imm' in ops ?
        ` Write \`${mnemonic} #${lit}\` if you meant the immediate.` : '';
    this.report('bare-number-operand',
                `\`${mnemonic} ${render(...operand)}\` uses ${lit} as an ` +
                `address, not a value.${immediate} Define a named constant ` +
                `(\`FOO = ${lit}\`), write the address in hex (\`${hex}\`), or ` +
                `force the address size (\`${mnemonic} ${forced}\`) to silence ` +
                `this.`,
                num.source);
  }

  /**
   * `lda <label` - the lo/hi byte of an address, used as an address itself,
   * which usually means the `#` fell off `lda #<label`.
   */
  private suspiciousAddressExpr(mnemonic: string, mode: Arg[0], ops: Ops,
                                expr: Expr|undefined, operand: Token[]): void {
    if (mode !== 'add') return;
    if (!('imm' in ops)) return;
    // The byte op has to be the whole expression. `lda <foo+1` parses as
    // `(<foo)+1` under both assemblers' precedence, and is left alone.
    if (expr?.op !== '<' && expr?.op !== '>') return;
    const inner = expr.args?.[0];
    // ca65 additionally requires a bare symbol here, and skips one it knows to
    // be zero page. `<zpsym` is the address itself which can be useful
    if (!inner || !isAddress(inner) || inner.meta?.zeropage) return;
    const first = operand[0];
    if (first.token !== 'op' || first.str !== expr.op) return;
    const text = render(...operand);
    const byte = first.str === '<' ? 'low' : 'high';
    this.report('suspicious-address-expr',
                `\`${mnemonic} ${text}\` takes the ${byte} byte but is used ` +
                `as an address, not an immediate. Did you mean ` +
                `\`${mnemonic} #${text}\`? Write \`${mnemonic} z:${text}\` if ` +
                `the zero-page read is intentional.`,
                first.source);
  }
}

function isAddress(expr: Expr): boolean {
  return expr.op === 'sym' || expr.meta?.chunk != null;
}

function sameOrigin(a?: SourceInfo, b?: SourceInfo): boolean {
  for (;;) {
    if (!a || !b) return !a && !b;
    if (a.file !== b.file || a.line !== b.line) return false;
    a = a.parent;
    b = b.parent;
  }
}

/**
 * Whether the operand carries a `z:`/`a:` address size anywhere - at the front,
 * or inside the parens of an indirect operand.
 */
function hasAddrSize(operand: Token[]): boolean {
  for (let i = 0; i < operand.length; i++) {
    if (Tokens.addrSize(operand, i)) return true;
  }
  return false;
}

/** Addressing-mode punctuation, as opposed to the address itself. */
function isSyntax(token: Token): boolean {
  switch (token.token) {
    case 'lp': case 'rp': case 'lb': case 'rb': return true;
    case 'op': return token.str === ',';
    case 'ident':
      return token.str.length === 1 && /^[xy]$/i.test(token.str);
    default: return false;
  }
}

/** Best-effort source text for a run of tokens, for use in a message. */
function render(...tokens: Token[]): string {
  return tokens.map(token => {
    switch (token.token) {
      case 'num':
        if (token.radix === 16) return hexLiteral(token.num);
        if (token.radix === 2) return `%${token.num.toString(2)}`;
        return String(token.num);
      case 'ident': return token.str;
      case 'op': return token.str;
      case 'cs': return token.rawStr ?? token.str;
      case 'str': return JSON.stringify(token.str);
      case 'lp': return '(';
      case 'rp': return ')';
      case 'lb': return '[';
      case 'rb': return ']';
      default: return '';
    }
  }).join('');
}

function hexLiteral(num: number): string {
  return `$${num.toString(16).padStart(num > 0xff ? 4 : 2, '0')}`;
}
