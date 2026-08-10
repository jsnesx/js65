
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
 * What the assembler knows about an `rts` when it reaches one: where it sits in
 * the back-referable list, and whether a `:>rts` forward ref already claimed it.
 */
export interface RtsAnchor {
  index: number;
  claimed: boolean;
}

/** The previous instruction, for rules that read a pair of adjacent ones. */
interface PrevInstruction {
  readonly mnemonic: string;
  readonly mode: Arg[0];
  /** The whole source line, so a fix can edit the mnemonic where it stands. */
  readonly tokens: Token[];
}

/** A `jsr`/`rts` pair, held until the end in case something references the `rts`. */
interface TailCall {
  readonly jsr: PrevInstruction;
  readonly rts: Token;
  /** This `rts`'s index in the assembler's back-referable list. */
  readonly index: number;
}

/** One open `.proc`, tracking what would run after it falls off the end. */
interface ProcFrame {
  readonly name: string;
  /** Instructions emitted directly in this proc, not in a nested one. */
  count: number;
  /** The most recent instruction as written, for the message. */
  lastText: string;
  /** Whether that instruction transfers control away. */
  terminates: boolean;
  /** Whether an `.assert` has vouched for the address since that instruction. */
  asserted: boolean;
}

/**
 * Runs the lint rules. The assembler owns one of these and calls into it as it
 * walks the source; every rule reports through `report()`, which resolves the
 * configured level and honors suppression pragmas.
 */
export class Linter {
  // We only track procs and not scopes
  private readonly procStack: ProcFrame[] = [];
  /** The instruction directly above the next one, cleared by `endInstructionSequence()`. */
  private prev?: PrevInstruction;
  /** Tail calls seen so far, reported by `closeModule()` once nothing can claim them. */
  private readonly tailCalls: TailCall[] = [];
  /** `rts` indices that a `:<rts` back reference pointed at. */
  private readonly referencedRts = new Set<number>();

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
  instruction(mnemonic: string, arg: Arg, ops: Ops, tokens?: Token[],
              rts?: RtsAnchor): void {
    const frame = this.procStack[this.procStack.length - 1];
    if (frame) {
      frame.count++;
      frame.lastText = renderInstruction(mnemonic, tokens);
      frame.terminates = transfersControl(mnemonic, ops);
      frame.asserted = false;
    }
    const prev = this.prev;
    this.prev = tokens ? {mnemonic, mode: arg[0], tokens} : undefined;
    if (rts && tokens && arg[0] === 'imp') {
      this.jsrRtsTailCall(prev, tokens[0], rts);
    }
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

  /**
   * Breaks the run of adjacent instructions. We are looking for pairs of instructions
   * to lint against, and if there is a directive or branch target to this, then
   * we need to break the sequence.
   */
  endInstructionSequence(): void {
    this.prev = undefined;
  }

  /**
   * Called for each label definition, before it is defined. A label is a branch
   * target and so breaks the sequence, but it is first the target the
   * instruction above may be jumping to.
   */
  label(ident: string): void {
    this.jmpFallthrough(ident);
    this.endInstructionSequence();
  }

  /** `jmp next` sitting directly above `next:`, which the jump falls into. */
  private jmpFallthrough(ident: string): void {
    const prev = this.prev;
    if (prev?.mnemonic !== 'jmp' || prev.mode !== 'add') return;
    // Only a bare symbol - `jmp next+1` lands somewhere else entirely, and
    // `jmp Foo::next` is not necessarily this `next`.
    const operand = prev.tokens.slice(1);
    if (operand.length !== 1) return;
    const target = operand[0];
    if (target.token !== 'ident' || target.str !== ident) return;
    this.report('jmp-fallthrough',
                `\`jmp ${ident}\` jumps to the very next instruction. Use ` +
                `\`FALLTHROUGH ${ident}\` (from \`.macpack common\`) to ` +
                `assert the adjacency instead, or ` +
                `\`; js65-lint-disable-next-line jmp-fallthrough\` to keep ` +
                `the jump.`,
                prev.tokens[0].source,
                fallthroughFix(prev.tokens[0], ident));
  }

  /** Called for a `:<rts` back reference, which claims the `rts` at `index`. */
  rtsBackref(index: number): void {
    this.referencedRts.add(index);
  }

  /**
   * search for `jsr sub \n rts` , which is just  `jmp sub`
   * its possible there is a deferred jump here such as a `:<rts` further down,
   * so we have to check for that at the module finalization.
   */
  private jsrRtsTailCall(prev: PrevInstruction|undefined, rts: Token,
                         anchor: RtsAnchor): void {
    // A `:>rts` from above already jumps here, so the `rts` has to stay.
    if (anchor.claimed) return;
    if (prev?.mnemonic !== 'jsr' || prev.mode !== 'add') return;
    this.tailCalls.push({jsr: prev, rts, index: anchor.index});
  }

  /** Reports the deferred rules. Called once, after the whole module is read. */
  closeModule(): void {
    for (const {jsr, rts, index} of this.tailCalls) {
      if (this.referencedRts.has(index)) continue;
      const target = render(...jsr.tokens.slice(1));
      this.report('jsr-rts-tail-call',
                  `\`jsr ${target}\` followed by \`rts\` is a tail call. ` +
                  `\`jmp ${target}\` is one byte shorter and one stack level ` +
                  `cheaper. Label the \`rts\` if something branches to it.`,
                  jsr.tokens[0].source,
                  tailCallFix(jsr.tokens[0], target, rts));
    }
    this.tailCalls.length = 0;
  }

  /** Called for `.proc`, after the scope has been entered. */
  enterProc(name: string): void {
    this.procStack.push(
        {name, count: 0, lastText: '', terminates: false, asserted: false});
  }

  /** Called for `.assert` so we can check if the user asserted something here. */
  assert(): void {
    const frame = this.procStack[this.procStack.length - 1];
    if (frame) frame.asserted = true;
  }

  /** Called for `.endproc`, before the scope is left. */
  exitProc(at?: SourceInfo): void {
    const frame = this.procStack.pop();
    if (!frame) return;
    // A proc that emitted no instructions is a data table, which doesn't count.
    if (!frame.count || frame.terminates || frame.asserted) return;
    this.report('endproc-no-terminator',
                `\`.endproc\` for \`${frame.name}\` ends with ` +
                `\`${frame.lastText}\`, instead of a terminal instruction. ` +
                `Add a terminating opcode (rts/rit/jmp/jsr/branch), assert the ` +
                `fall-through with \`FALLTHROUGH next\` (from ` +
                `\`.macpack common\`), or \`; js65-lint-disable-next-line ` +
                `endproc-no-terminator\` if it is intentional.`,
                at);
  }
}

/**
 * Mnemonics that do not simply continue on to the next instruction. `jsr` is
 * included because a proc ending in one can be used in cases of a double return
 * or a JumpEngine / stack manipulation based dispatcher. (Also includes branches)
 */
const TRANSFERS_CONTROL = new Set(['jmp', 'jsr', 'rts', 'rti', 'brk']);

/** Whether `mnemonic` transfers control away from the following instruction. */
function transfersControl(mnemonic: string, ops: Ops): boolean {
  return TRANSFERS_CONTROL.has(mnemonic) || 'rel' in ops;
}

/**
 * The edits that turn `jsr foo` plus `rts` into `jmp foo`: rewrite the mnemonic
 * in place and drop the whole `rts` line. Don't offer this for macro expansions
 */
function tailCallFix(jsr: Token, target: string,
                     rts: Token): MessageFix|undefined {
  const from = jsr.source;
  const to = rts.source;
  if (!from || !to || from.parent || to.parent) return undefined;
  if (from.file !== to.file || to.line <= from.line) return undefined;
  const written = Tokens.str(jsr);
  // `JSR` and `jsr` are both common; keep whichever the file uses.
  const jmp = written === written.toUpperCase() ? 'JMP' : 'jmp';
  return {
    title: `Replace \`${written} ${target}\` and \`rts\` with \`${jmp} ${target}\``,
    edits: [{
      file: from.file,
      startLine: from.line,
      startColumn: from.column,
      endLine: from.line,
      endColumn: from.column + written.length,
      newText: jmp,
    }, {
      // The `rts` is the only thing on its line, so take the line and its break.
      file: to.file,
      startLine: to.line,
      startColumn: 0,
      endLine: to.line + 1,
      endColumn: 0,
      newText: '',
    }],
  };
}

/**
 * The edit that turns `jmp next` into `FALLTHROUGH next`, keeping the operand
 * as written. Don't offer this for macro expansions.
 */
function fallthroughFix(jmp: Token, target: string): MessageFix|undefined {
  const from = jmp.source;
  if (!from || from.parent) return undefined;
  const written = Tokens.str(jmp);
  return {
    title: `Replace \`${written} ${target}\` with \`FALLTHROUGH ${target}\``,
    edits: [{
      file: from.file,
      startLine: from.line,
      startColumn: from.column,
      endLine: from.line,
      endColumn: from.column + written.length,
      newText: 'FALLTHROUGH',
    }],
  };
}

/** The instruction as written, or just the mnemonic if it had no source. */
function renderInstruction(mnemonic: string, tokens?: Token[]): string {
  if (!tokens?.length) return mnemonic;
  const operand = render(...tokens.slice(1));
  return operand ? `${render(tokens[0])} ${operand}` : render(tokens[0]);
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
