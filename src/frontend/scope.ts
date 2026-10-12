// SPDX-License-Identifier: MPL-2.0

import type { ErrorCollector } from '../error.ts';
import type { Expr } from '../expr.ts';
import type * as mod from '../module.ts';
import * as Tokens from '../token.ts';

/**
 * Symbol tag used to store the size of something in the symbol table while
 * keeping it inaccessible to the user. When a scope is closed, or
 * the label's chunk ends, we can create this size symbol in case the user
 * decides to query the size with `.sizeof` later.
 */
export const SIZE_NAME = '.size';
export const SIZE_SUFFIX = `::${SIZE_NAME}`;

export const RE_SCOPE_SPLIT = /::/g;

/** Whether a symbol name is one of the internal size entries described above. */
export function isSizeOfSymbol(name: string): boolean {
  return name === SIZE_NAME || name.endsWith(SIZE_SUFFIX);
}

export class Symbol {
  /**
   * Index into the global symbol array used at link time.
   * Mutable syms aren't kept for link time, so they use -1 here
   */
  id?: number;
  /** Whether the symbol has been explicitly scoped. */
  scoped?: boolean;
  /**
   * The expression for the symbol. Must be a statically-evaluatable constant
   * for mutable symbols. Undefined for forward-referenced symbols.
   */
  expr?: Expr;
  /** Name this symbol is exported as. */
  export?: string;
  /** Whether this symbol denotes a location rather than a plain constant */
  isLabel?: boolean;
  /** 
   * Where the symbol was defined (label/assignment).
   * Populated only when `AssemblerOptions.collectReferences` is set.
   */
  def?: Tokens.SourceInfo;
  /**
   * List of places this symbol was referenced. We only keep the first 
   * reference, unless we are running the LSP where we need all references. 
   */
  refs?: Tokens.SourceInfo[];
}

export function firstRef(sym?: Symbol): Tokens.SourceInfo|undefined {
  return sym?.refs?.[0];
}

/** What to do when a qualified name mentions a scope that doesn't exist yet. */
export type MissingScope = 'fail'|'undefined'|'create';

export interface ResolveOpts {
  // Whether to create a forward reference for missing symbols.
  allowForwardRef?: boolean;
  // Reference Tokens.
  ref?: {source?: Tokens.SourceInfo};
  // How to handle a name whose scope hasn't been declared yet.
  missingScope?: MissingScope;
}

export interface FwdRefResolveOpts extends ResolveOpts {
  allowForwardRef: true;
}

export abstract class BaseScope {
  //closed = false;
  readonly symbols = new Map<string, Symbol>();
  /** Whether to record reference+defintion sites on the symbols in this scope. */
  collectRefs?: boolean;

  protected pickScope(name: string,
                      _at?: {source?: Tokens.SourceInfo},
                      _missing?: MissingScope): [string, BaseScope]|undefined {
    return [name, this];
  }

  // TODO - may need additional options:
  //   - lookup constant - won't return a mutable value or a value from
  //     a parent scope, implies no forward ref
  //   - shallow - don't recurse up the chain, for assignment only??
  // Might just mean allowForwardRef is actually just a mode string?
  //  * ca65's .definedsymbol is more permissive than .ifconst
  resolve(name: string, opts: FwdRefResolveOpts): Symbol;
  resolve(name: string, opts?: ResolveOpts): Symbol|undefined;
  resolve(name: string, opts: ResolveOpts = {}):
      Symbol|undefined {
    const {allowForwardRef = false, ref} = opts;
    const missingScope = opts.missingScope ??
        (allowForwardRef ? 'create' : 'fail');
    const picked = this.pickScope(name, ref, missingScope);
    if (!picked) return undefined;
    const [tail, scope] = picked;
    const sym = scope.symbols.get(tail);
//console.log('resolve:',name,'sym=',sym,'fwd?',allowForwardRef);
    if (sym) {
      if (tail !== name) sym.scoped = true;
      // Keep the first reference site so error messages can point at it. Only
      // keep the rest when this scope tree opted in, so plain builds stay at one
      // array element per symbol to save RAM.
      if (ref?.source && (scope.collectRefs || !sym.refs)) {
        (sym.refs ??= []).push(ref.source);
      }
      return sym;
    }
    if (!allowForwardRef) return undefined;
    // if (scope.closed) throw new Error(`Could not resolve symbol: ${name}`);
    // make a new symbol - but only in an open scope
    //const symbol = {id: this.symbolArray.length};
//console.log('created:',symbol);
    //this.symbolArray.push(symbol);
    const symbol: Symbol = ref?.source ? {refs: [ref.source]} : {};
    scope.symbols.set(tail, symbol);
    if (tail !== name) symbol.scoped = true;
    return symbol;
  }

  /** Insert a brand new symbol into the table, scoped if there is one open */
  declare(name: string, symbol: Symbol, at?: {source?: Tokens.SourceInfo}): Symbol {
    const [tail, scope] = this.pickScope(name, at ?? {source: firstRef(symbol)})!;
    scope.symbols.set(tail, symbol);
    if (tail !== name) symbol.scoped = true;
    return symbol;
  }
}

export class Scope extends BaseScope {
  readonly global: Scope;
  readonly children = new Map<string, Scope>();
  readonly anonymousChildren: Scope[] = [];

  /** Position when the scope was entered, for sizing it on exit. */
  startPc?: Expr;
  /** Name of the label this scope belongs to */
  label?: string;
  /** Created by a forward reference, before its `.scope`/`.proc` was seen. */
  forwardDeclared?: boolean;
  /** This scope's own name, unset for the global and anonymous scopes. */
  name?: string;
  /** Set for `.struct`/`.union`/`.enum` scopes, for debug info. */
  dbgType?: 'struct'|'enum';
  /** 1-based number of an unnamed scope, for debug info. */
  anonId?: number;
  /** Bytes emitted directly in this scope, not counting nested scopes. */
  debugRuns?: mod.DebugScopeRun[];

  /** Find the scope prefix without the name of the label */
  qualifiedPrefix(): string {
    const parts: string[] = [];
    for (let scope: Scope|undefined = this; scope?.parent; scope = scope.parent) {
      if (scope.name) parts.unshift(scope.name);
    }
    return parts.length ? `${parts.join('::')}::` : '';
  }

  constructor(readonly parent?: Scope, public kind?: 'scope'|'proc') {
    super();
    this.global = parent ? parent.global : this;
    this.collectRefs = parent?.collectRefs;
  }

  /**
   * Walks through the scope tree to find the child scope that matches.
   * Returns an object {scope: found} or {missing: index} if not found
   */
  private walkScopes(parts: string[]): {scope: Scope}|{missing: number} {
    // deno-lint-ignore no-this-alias
    let scope: Scope = this;
    for (let i = 0; i < parts.length; i++) {
      if (!i && !parts[i]) { // leading `::` - global
        scope = scope.global;
        continue;
      }
      let child = scope.children.get(parts[i]);
      while (!i && scope.parent && !child) {
        child = (scope = scope.parent).children.get(parts[i]);
      }
      if (!child) return {missing: i};
      scope = child;
    }
    return {scope};
  }

  /** Look up a scope by (possibly qualified) name. Undefined if there is none. */
  findScope(name: string): Scope|undefined {
    const found = this.walkScopes(name.split(RE_SCOPE_SPLIT));
    return 'scope' in found ? found.scope : undefined;
  }

  /** Splits a qualified symbol name into its unqualified tail and owning scope. */
  pickScope(name: string, at?: {source?: Tokens.SourceInfo},
            missing: MissingScope = 'fail'): [string, Scope]|undefined {
    const split = name.split(RE_SCOPE_SPLIT);
    const tail = split.pop()!;
    const found = this.walkScopes(split);
    // If the name has an explicit scope, this is an error?
    if ('missing' in found) {
      // A scope declared later in the file isn't an error for a query, and a
      // reference can forward-declare it the same way a bare name does.
      if (missing === 'undefined') return undefined;
      if (missing === 'create') return [tail, this.createScopes(split)];
      Tokens.fail(
          `Could not resolve scope ${split.slice(0, found.missing + 1).join('::')}`,
          at);
    }
    return [tail, found.scope];
  }

  /** Fills in placeholders for a qualified name whose scopes aren't open yet. */
  private createScopes(parts: string[]): Scope {
    // deno-lint-ignore no-this-alias
    let scope: Scope = this;
    for (let i = 0; i < parts.length; i++) {
      if (!i && !parts[i]) {
        scope = scope.global;
        continue;
      }
      let child = scope.children.get(parts[i]);
      while (!i && scope.parent && !child) {
        child = (scope = scope.parent).children.get(parts[i]);
      }
      if (!child) {
        child = new Scope(scope);
        child.forwardDeclared = true;
        child.name = parts[i];
        scope.children.set(parts[i], child);
      }
      scope = child;
    }
    return scope;
  }

  // close() {
  //   if (!this.parent) throw new Error(`Cannot close global scope`);
  //   this.closed = true;
  //   // Any undefined identifiers in the scope are automatically
  //   // promoted to the parent scope.
  //   for (const [name, sym] of this.symbols) {
  //     if (sym.expr) continue; // if it's defined in the scope, do nothing
  //     const parentSym = this.parent.symbols.get(sym);
  //   }
  // }
}

export class CheapScope extends BaseScope {

  /** Clear everything out, making sure everything was defined. */
  clear(collector?: ErrorCollector) {
    this.validate(collector);
    this.symbols.clear();
  }
  /**
   * Given a collector, records every still-undefined cheap label and returns
   * normally; without one it throws on the first, which is what the mid-line
   * callers want (`line()` records and resyncs for them).
   */
  validate(collector?: ErrorCollector) {
    for (const [name, sym] of this.symbols) {
      if (!sym.expr) {
        // The location rides on `.source` rather than being baked into the text.
        const msg = `Cheap local label never defined: ${name}`;
        if (!collector) Tokens.fail(msg, {source: firstRef(sym)});
        collector.add('error', msg, firstRef(sym));
      }
    }
  }
}

export type ParsedSymbol = {type: 'pc'|'none'}|{type: 'anon'|'rel'|'rts', num: number};
export function parseSymbol(name: string): ParsedSymbol {
  if (name === '*') return {type: 'pc'};

  if (/^:\++$/.test(name)) return {type: 'anon', num: name.length - 1};
  if (/^:\+\d+$/.test(name)) return {type: 'anon', num: parseInt(name.substring(2))};
  if (/^:-+$/.test(name)) return {type: 'anon', num: 1 - name.length};
  if (/^:-\d+$/.test(name)) return {type: 'anon', num: -parseInt(name.substring(2))};

  if (/^:>*rts$/.test(name)) return {type: 'rts', num: Math.max(name.length - 4, 1)};
  if (/^:<+rts$/.test(name)) return {type: 'rts', num: 4 - name.length};

  if (/^\++$/.test(name)) return {type: 'rel', num: name.length};
  if (/^-+$/.test(name)) return {type: 'rel', num: -name.length};
  return {type: 'none'};
}
