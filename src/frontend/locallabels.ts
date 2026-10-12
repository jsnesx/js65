// SPDX-License-Identifier: MPL-2.0

import type { Expr } from '../expr.ts';
import type { RtsAnchor } from './lint.ts';
import type { ParsedSymbol, Symbol } from './scope.ts';

/** Anonymous (`:+`/`:-`), relative (`++`/`--`) and `:rts` labels. */
export class LocalLabels {
  /** Symbols made by forward refs to anonymous labels. */
  private anonymousForward: Symbol[] = [];

  /** List of chunk/offset positions of previous anonymous labels. */
  private anonymousReverse: Expr[] = [];

  /** Symbols made by forward refs to relative labels, by depth. */
  private relativeForward: (Symbol|undefined)[] = [];

  /** Map of chunk/offset positions of back-referable relative labels. */
  private relativeReverse: Expr[] = [];

  /** Symbols made by forward refs to rts statements. */
  private rtsRefsForward: Symbol[] = [];

  /** List of chunk/offset positions of back-referable rts statements. */
  private rtsRefsReverse: Expr[] = [];

  constructor(private readonly allocSymbol: () => Symbol,
              private readonly fail: (msg: string) => never,
              private readonly rtsBackref: (index: number) => void) {}

  /** Undefined for `:+0`/`:-0`, which resolve as ordinary names. */
  resolve(name: string, parsed: ParsedSymbol): Expr|undefined {
    if (parsed.type === 'anon' && parsed.num > 0) {
      // anonymous forward ref
      const i = parsed.num - 1;
      return this.forwardRef(this.anonymousForward[i] ??= this.allocSymbol());
    } else if (parsed.type === 'rts' && parsed.num > 0) {
      // rts forward ref
      const i = parsed.num - 1;
      return this.forwardRef(this.rtsRefsForward[i] ??= this.allocSymbol());
    } else if (parsed.type === 'rel' && parsed.num > 0) {
      // relative forward ref
      return this.forwardRef(this.relativeForward[name.length - 1] ??= this.allocSymbol());
    } else if (parsed.type === 'anon' && parsed.num < 0) {
      // anonymous back ref
      const i = this.anonymousReverse.length + parsed.num;
      if (i < 0) this.fail(`Bad anonymous backref: ${name}`);
      return this.anonymousReverse[i];
    } else if (parsed.type === 'rts' && parsed.num < 0) {
      // rts back ref
      const i = this.rtsRefsReverse.length + parsed.num;
      if (i < 0) this.fail(`Bad rts backref: ${name}`);
      // That `rts` is a branch target now, so it can't be linted away.
      this.rtsBackref(i);
      return this.rtsRefsReverse[i];
    } else if (parsed.type === 'rel' && parsed.num < 0) {
      // relative back ref
      const expr = this.relativeReverse[name.length - 1];
      if (expr == null) this.fail(`Bad relative backref: ${name}`);
      return expr;
    }
    return undefined;
  }

  private forwardRef(sym: Symbol): Expr {
    return {op: 'sym', num: sym.id!};
  }

  /** Defines `:`, `+`.. or `-`.., returning which way it points or undefined. */
  label(ident: string, expr: Expr): '+'|'-'|undefined {
    if (ident === ':') {
      // anonymous label - shift any forward refs off, and push onto the backs.
      this.anonymousReverse.push(expr);
      const sym = this.anonymousForward.shift();
      if (sym != null) sym.expr = expr;
      return '+';
    } else if (/^\++$/.test(ident)) {
      // relative forward ref - fill in global symbol we made earlier
      const sym = this.relativeForward[ident.length - 1];
      this.relativeForward[ident.length - 1] = undefined;
      if (sym != null) sym.expr = expr;
      return '+';
    } else if (/^-+$/.test(ident)) {
      // relative backref - store the expr for later
      this.relativeReverse[ident.length - 1] = expr;
      return '-';
    }
    return undefined;
  }

  /** Records an `rts` at `expr` for `:+rts`/`:-rts` refs. */
  rts(expr: Expr): RtsAnchor {
    const index = this.rtsRefsReverse.push(expr) - 1;
    const sym = this.rtsRefsForward.shift();
    if (sym != null) sym.expr = expr;
    return {index, claimed: sym != null};
  }
}
