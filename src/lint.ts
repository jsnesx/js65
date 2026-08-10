
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
 *
 * Each rule is a `LintRule` subclass holding whatever state it needs, and
 * `Linter` is the dispatcher: it decides which rules are on and fans the
 * assembler's callbacks out to them.
 */

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
export type Ops = {[mode in AddressingMode]?: number};

/**
 * What the assembler knows about an `rts` when it reaches one: where it sits in
 * the back-referable list, and whether a `:>rts` forward ref already claimed it.
 */
export interface RtsAnchor {
  index: number;
  claimed: boolean;
}

/** An instruction, as the assembler hands it to the rules. */
export interface LintInstruction {
  readonly mnemonic: string;
  readonly arg: Arg;
  readonly ops: Ops;
  /** The whole source line, absent for the programmatic API's instructions. */
  readonly tokens?: Token[];
  /** Set only for an `rts`, which other things can point at. */
  readonly rts?: RtsAnchor;
}

/**
 * Reports one lint. The `Linter` binds a rule's id and level into this, so a
 * rule only says what is wrong and, when it can, how to fix it.
 */
export type Report =
    (message: string, source?: SourceInfo, fix?: MessageFix) => void;

/**
 * One lint rule, holding whatever state it needs to track across the assembly.
 * Every callback is a no-op by default, so a rule overrides only the ones it
 * cares about. Rules are constructed once per assembly, and only when they are
 * turned on - a rule that is off costs nothing.
 */
export abstract class LintRule {
  /** @param report Reports this rule, at the level it is configured for. */
  constructor(protected readonly report: Report) {}

  /** An instruction, after its mnemonic is known to be valid. */
  instruction(_inst: LintInstruction): void {}

  /** A label definition, which is also an `endInstructionSequence()`. */
  label(_ident: string): void {}

  /**
   * Breaks the run of adjacent instructions. We are looking for pairs of
   * instructions to lint against, and if there is a directive or branch target
   * to this, then we need to break the sequence.
   */
  endInstructionSequence(): void {}

  /** A `:<rts` back reference, which claims the `rts` at `index`. */
  rtsBackref(_index: number): void {}

  /** A `.proc`, after the scope has been entered. */
  enterProc(_name: string): void {}

  /** An `.assert`, vouching for wherever the pc has landed. */
  assert(): void {}

  /** An `.endproc`, before the scope is left. */
  exitProc(_at?: SourceInfo): void {}

  /** The end of the module: the last chance to report anything deferred. */
  closeModule(): void {}
}

/**
 * The static side of a rule class, which is its entry in `LINT_RULES`. Keeping
 * the identity on the class puts it next to the code that implements it.
 */
export interface LintRuleClass {
  /** Rule id, as it appears in a pragma, `-Wno-<id>`, or a diagnostic's code. */
  readonly id: string;
  /** Level reported when the project has not configured this rule. */
  readonly level: LintLevel;
  /** One-line summary, shown by `js65 --help`. */
  readonly description: string;
  new (report: Report): LintRule;
}

/** `lda 5`, `lda (5),y`, `sta 5` - a decimal or binary literal as an address. */
class BareNumberOperand extends LintRule {
  static readonly id = 'bare-number-operand';
  static readonly level: LintLevel = 'warning';
  static readonly description =
      'a lone decimal/binary literal used as an address, e.g. `lda 5`';

  override instruction(inst: LintInstruction): void {
    const site = inst.tokens?.[0].source;
    const operand = addressOperand(inst);
    if (!operand) return;
    // Strip the operand down to just the number value
    const bare = operand.filter(t => !isSyntax(t));
    if (bare.length !== 1) return;
    const num = bare[0];
    if (num.token !== 'num' || (num.radix !== 10 && num.radix !== 2)) return;
    // For macros/define, check if the number got here through a replacement
    if (!sameOrigin(num.source, site)) return;

    const {mnemonic, ops} = inst;
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
    this.report(`\`${mnemonic} ${render(...operand)}\` uses ${lit} as an ` +
                `address, not a value.${immediate} Define a named constant ` +
                `(\`FOO = ${lit}\`), write the address in hex (\`${hex}\`), or ` +
                `force the address size (\`${mnemonic} ${forced}\`) to silence ` +
                `this.`,
                num.source);
  }
}

/**
 * `lda <label` - the lo/hi byte of an address, used as an address itself,
 * which usually means the `#` fell off `lda #<label`.
 */
class SuspiciousAddressExpr extends LintRule {
  static readonly id = 'suspicious-address-expr';
  static readonly level: LintLevel = 'warning';
  static readonly description =
      'a lo/hi byte expression used as an address, e.g. `lda <label`';

  override instruction(inst: LintInstruction): void {
    const {mnemonic, arg, ops} = inst;
    if (arg[0] !== 'add') return;
    if (!('imm' in ops)) return;
    const operand = addressOperand(inst);
    if (!operand) return;
    // The byte op has to be the whole expression. `lda <foo+1` parses as
    // `(<foo)+1` under both assemblers' precedence, and is left alone.
    const expr: Expr|undefined = arg[1];
    if (expr?.op !== '<' && expr?.op !== '>') return;
    const inner = expr.args?.[0];
    // ca65 additionally requires a bare symbol here, and skips one it knows to
    // be zero page. `<zpsym` is the address itself which can be useful
    if (!inner || !isAddress(inner) || inner.meta?.zeropage) return;
    const first = operand[0];
    if (first.token !== 'op' || first.str !== expr.op) return;
    const text = render(...operand);
    const byte = first.str === '<' ? 'low' : 'high';
    this.report(`\`${mnemonic} ${text}\` takes the ${byte} byte but is used ` +
                `as an address, not an immediate. Did you mean ` +
                `\`${mnemonic} #${text}\`? Write \`${mnemonic} z:${text}\` if ` +
                `the zero-page read is intentional.`,
                first.source);
  }
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

/** A `.proc` whose last instruction runs on into whatever comes after it. */
class EndprocNoTerminator extends LintRule {
  static readonly id = 'endproc-no-terminator';
  static readonly level: LintLevel = 'warning';
  static readonly description =
      '`.endproc` whose last instruction falls through';

  // We only track procs and not scopes
  private readonly procStack: ProcFrame[] = [];

  override instruction({mnemonic, ops, tokens}: LintInstruction): void {
    // Only the innermost proc is affected; closing a nested one does not
    // vouch for the proc around it.
    const frame = this.procStack[this.procStack.length - 1];
    if (!frame) return;
    frame.count++;
    frame.lastText = renderInstruction(mnemonic, tokens);
    frame.terminates = transfersControl(mnemonic, ops);
    frame.asserted = false;
  }

  override enterProc(name: string): void {
    this.procStack.push(
        {name, count: 0, lastText: '', terminates: false, asserted: false});
  }

  override assert(): void {
    const frame = this.procStack[this.procStack.length - 1];
    if (frame) frame.asserted = true;
  }

  override exitProc(at?: SourceInfo): void {
    const frame = this.procStack.pop();
    if (!frame) return;
    // A proc that emitted no instructions is a data table, which doesn't count.
    if (!frame.count || frame.terminates || frame.asserted) return;
    this.report(`\`.endproc\` for \`${frame.name}\` ends with ` +
                `\`${frame.lastText}\`, instead of a terminal instruction. ` +
                `Add a terminating opcode (rts/rit/jmp/jsr/branch), assert the ` +
                `fall-through with \`FALLTHROUGH next\` (from ` +
                `\`.macpack common\`), or \`; js65-lint-disable-next-line ` +
                `endproc-no-terminator\` if it is intentional.`,
                at);
  }
}

/** The previous instruction, for rules that read a pair of adjacent ones. */
interface PrevInstruction {
  readonly mnemonic: string;
  readonly mode: Arg[0];
  /** The whole source line, so a fix can edit the mnemonic where it stands. */
  readonly tokens: Token[];
}

/**
 * Base for the rules that look at an instruction together with the one
 * directly above it. A subclass overriding `instruction()` must call `super`,
 * after reading `prev`, to keep the tracking going.
 */
abstract class AdjacentInstructions extends LintRule {
  /** The instruction directly above the next one, cleared at a barrier. */
  protected prev?: PrevInstruction;

  override instruction({mnemonic, arg, tokens}: LintInstruction): void {
    // An instruction with no source line came from the programmatic API, where
    // there is no "line above" to speak of.
    this.prev = tokens ? {mnemonic, mode: arg[0], tokens} : undefined;
  }

  override endInstructionSequence(): void {
    this.prev = undefined;
  }
}

/** A `jsr`/`rts` pair, held until the end in case something references the `rts`. */
interface TailCall {
  readonly jsr: PrevInstruction;
  readonly rts: Token;
  /** This `rts`'s index in the assembler's back-referable list. */
  readonly index: number;
}

/**
 * search for `jsr sub \n rts` , which is just  `jmp sub`
 * its possible there is a deferred jump here such as a `:<rts` further down,
 * so we have to check for that at the module finalization.
 */
class JsrRtsTailCall extends AdjacentInstructions {
  static readonly id = 'jsr-rts-tail-call';
  static readonly level: LintLevel = 'info';
  static readonly description =
      '`jsr` immediately followed by `rts`, which could be a `jmp`';

  /** Candidates seen so far, reported once nothing can claim their `rts`. */
  private readonly tailCalls: TailCall[] = [];
  /** `rts` indices that a `:<rts` back reference pointed at. */
  private readonly referencedRts = new Set<number>();

  override instruction(inst: LintInstruction): void {
    const prev = this.prev;
    super.instruction(inst);
    const {arg, tokens, rts} = inst;
    if (!rts || !tokens || arg[0] !== 'imp') return;
    // A `:>rts` from above already jumps here, so the `rts` has to stay.
    if (rts.claimed) return;
    if (prev?.mnemonic !== 'jsr' || prev.mode !== 'add') return;
    this.tailCalls.push({jsr: prev, rts: tokens[0], index: rts.index});
  }

  override rtsBackref(index: number): void {
    this.referencedRts.add(index);
  }

  override closeModule(): void {
    for (const {jsr, rts, index} of this.tailCalls) {
      if (this.referencedRts.has(index)) continue;
      const target = render(...jsr.tokens.slice(1));
      this.report(`\`jsr ${target}\` followed by \`rts\` is a tail call. ` +
                  `\`jmp ${target}\` is usually a free optimization.`+
                  `Label the \`rts\` to silence this warning or add \`; js65-lint-disable-next-line ` +
                `jsr-rts-tail-call\`.`,
                  jsr.tokens[0].source,
                  tailCallFix(jsr.tokens[0], target, rts));
    }
    this.tailCalls.length = 0;
  }
}

/** `jmp next` sitting directly above `next:`, which the jump falls into. */
class JmpFallthrough extends AdjacentInstructions {
  static readonly id = 'jmp-fallthrough';
  static readonly level: LintLevel = 'info';
  static readonly description =
      '`jmp` to the label defined on the next line';

  override label(ident: string): void {
    const prev = this.prev;
    if (prev?.mnemonic !== 'jmp' || prev.mode !== 'add') return;
    // Only a bare symbol - `jmp next+1` lands somewhere else entirely, and
    // `jmp Foo::next` is not necessarily this `next`.
    const operand = prev.tokens.slice(1);
    if (operand.length !== 1) return;
    const target = operand[0];
    if (target.token !== 'ident' || target.str !== ident) return;
    this.report(`\`jmp ${ident}\` jumps to the next instruction. Use ` +
                `\`FALLTHROUGH ${ident}\` (from \`.macpack common\`) to ` +
                `assert that this is intended, or ` +
                `\`; js65-lint-disable-next-line jmp-fallthrough\` to keep ` +
                `the jump.`,
                prev.tokens[0].source,
                fallthroughFix(prev.tokens[0], ident));
  }
}

/** Every rule js65 knows, in the order they are dispatched and reported. */
const RULES: readonly LintRuleClass[] = [
  BareNumberOperand,
  SuspiciousAddressExpr,
  EndprocNoTerminator,
  JsrRtsTailCall,
  JmpFallthrough,
];

export const LINT_RULES: ReadonlyMap<string, LintRuleClass> =
    new Map(RULES.map(rule => [rule.id, rule] as const));

/**
 * The assembler's way in to the lint rules. It resolves each rule's level from
 * the project's options, constructs the ones that are on, and fans every
 * callback out to them; the rules themselves keep all the state.
 */
export class Linter {
  /** The rules that are turned on, in `RULES` order. */
  private readonly rules: readonly LintRule[];

  constructor(errorCollector: ErrorCollector, opts: LintOptions = {},
              pragmas?: LintPragmas) {
    const rules: LintRule[] = [];
    if (opts.enabled !== false) {
      for (const [id, rule] of LINT_RULES) {
        const level = opts.rules?.[id] ?? rule.level;
        if (level === 'off') continue;
        rules.push(new rule((message, source, fix) => {
          if (pragmas?.suppressed(id, source)) return;
          errorCollector.add(level, message, source,
                             fix ? {code: id, fix} : {code: id});
        }));
      }
    }
    this.rules = rules;
  }

  /**
   * Called for each instruction the assembler encounters, after the mnemonic is
   * known to be valid. `tokens` is the whole source line, absent when the
   * instruction came from the programmatic API rather than from source.
   */
  instruction(mnemonic: string, arg: Arg, ops: Ops, tokens?: Token[],
              rts?: RtsAnchor): void {
    if (!this.rules.length) return;
    const inst: LintInstruction = {mnemonic, arg, ops, tokens, rts};
    for (const rule of this.rules) rule.instruction(inst);
  }

  /**
   * Called for each label definition, before it is defined. A label is a branch
   * target and so breaks the sequence, but it is first the target the
   * instruction above may be jumping to.
   */
  label(ident: string): void {
    for (const rule of this.rules) rule.label(ident);
    this.endInstructionSequence();
  }

  /** Called when anything other than a label breaks instruction adjacency. */
  endInstructionSequence(): void {
    for (const rule of this.rules) rule.endInstructionSequence();
  }

  /** Called for a `:<rts` back reference, which claims the `rts` at `index`. */
  rtsBackref(index: number): void {
    for (const rule of this.rules) rule.rtsBackref(index);
  }

  /** Called for `.proc`, after the scope has been entered. */
  enterProc(name: string): void {
    for (const rule of this.rules) rule.enterProc(name);
  }

  /** Called for `.assert` so we can check if the user asserted something here. */
  assert(): void {
    for (const rule of this.rules) rule.assert();
  }

  /** Called for `.endproc`, before the scope is left. */
  exitProc(at?: SourceInfo): void {
    for (const rule of this.rules) rule.exitProc(at);
  }

  /** Reports the deferred rules. Called once, after the whole module is read. */
  closeModule(): void {
    for (const rule of this.rules) rule.closeModule();
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
 * The operand tokens, when the instruction reaches an address as written:
 * anything but an immediate, and without a `z:`/`a:` size, which says the
 * author already spelled out what they meant.
 */
function addressOperand({arg, tokens}: LintInstruction): Token[]|undefined {
  const mode = arg[0];
  if (!tokens || mode === 'imm' || mode === 'imp' || mode === 'acc') {
    return undefined;
  }
  const operand = tokens.slice(1);
  if (!operand.length || hasAddrSize(operand)) return undefined;
  return operand;
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
