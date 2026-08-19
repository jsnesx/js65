
// SPDX-License-Identifier: MPL-2.0

/**
 * Sink that records `.macro` / `.define` definitions as the preprocessor
 * creates them, mirroring what `SymbolIndex` does for symbols. Only populated
 * when a frontend passes one in, so plain builds don't pay for it.
 */

import { Symbol } from './assembler.ts';
import type {Define} from './define.ts';
import type {Macro} from './macro.ts';
import type {SourceInfo} from './error.ts';
import * as Tokens from './token.ts';

/** One recorded macro or define, with the site that defined it. */
export interface IndexedMacro {
  readonly name: string;
  /** `'macro'` for `.macro`, `'define'` for `.define`. */
  readonly kind: 'macro' | 'define';
  /** The live macro object, so callers can call `expand()` on it. */
  readonly macro: Macro | Define;
  /** Where it was defined. The name token's source when debug info is on. */
  readonly definition?: SourceInfo;
}

/**
 * Records every macro/define the preprocessor defines. Later definitions of the
 * same name replace earlier ones, matching the preprocessor's own map
 * semantics (`.undefine` / `.delmacro` remove the entry).
 */
export class MacroIndex {
  private readonly entries = new Map<string, IndexedMacro>();

  /** Called by the preprocessor when a `.macro` or `.define` is defined. */
  record(name: string, kind: 'macro' | 'define', macro: Macro | Define,
         definition?: SourceInfo): void {
    this.entries.set(name, {name, kind, macro, definition});
  }

  /** Called by the preprocessor on `.undefine` / `.delmacro`. */
  remove(name: string): void {
    this.entries.delete(name);
  }

  /** Look up a recorded macro by name. */
  get(name: string): IndexedMacro | undefined {
    return this.entries.get(name);
  }

  /** Every recorded macro, in definition order. */
  all(): Iterable<IndexedMacro> {
    return this.entries.values();
  }

  get size(): number { return this.entries.size; }
}

export type SymbolKind = 'label' | 'constant' | 'enumMember' | 'structMember';

/** Partially mirrors the Scope class, but with only the things the LSP needs */
export interface IndexedScope {
  /** Simple (unqualified) name of the scope. Empty for anonymous scopes. */
  name: string;
  /** Fully-qualified name, segments joined by `::`. */
  qualifiedName: string;
  /** What kind of scope this is ie a `.scope` or `.proc`. */
  kind: 'scope' | 'proc';
  /** Source position of the opening `.scope`/`.proc` directive, when known. */
  start?: Tokens.SourceInfo;
  /** Source position of the matching `.endscope`/`.endproc`, when known. */
  end?: Tokens.SourceInfo;
  /** Direct child scopes, in declaration order. */
  children: IndexedScope[];
  /** Symbols declared in this scope, keyed by their unqualified name. */
  symbols: Map<string, Symbol>;
}

/**
 * Collector for symbols and scope data. Instead of trying to beat the existing
 * Scope classes into something the LSP server can use, we can just use this to
 * track scopes and symbols independently. 
 */
export class SymbolIndex {
  /** Root scope. Anything outside any `.scope`/`.proc` in this unit. */
  readonly root: IndexedScope = {
    name: '', qualifiedName: '', kind: 'scope',
    children: [], symbols: new Map(),
  };
  private readonly stack: IndexedScope[] = [this.root];

  /** Called by the Assembler when a `.scope`/`.proc` is entered. */
  enterScope(name: string | undefined, kind: 'scope' | 'proc', start?: Tokens.SourceInfo): void {
    const parent = this.stack[this.stack.length - 1];
    const anon = name == null;
    const simpleName = anon ? `@${parent.children.length}` : name;
    const qualifiedName = parent === this.root
        ? simpleName
        : `${parent.qualifiedName}::${simpleName}`;
    const entry: IndexedScope = {
      name: simpleName, qualifiedName, kind, start,
      children: [], symbols: new Map(),
    };
    parent.children.push(entry);
    this.stack.push(entry);
  }

  /** Called by the Assembler when the matching `.endscope`/`.endproc` runs. */
  exitScope(end?: Tokens.SourceInfo): void {
    const entry = this.stack.pop();
    if (entry && end) entry.end = end;
  }

  // Used to find the module for a sym so we can look up the chunk it landed in
  private readonly modules = new WeakMap<Symbol, string>();
  private readonly kinds = new WeakMap<Symbol, SymbolKind>();

  /** Called by the Assembler after a symbol is assigned. */
  recordSymbol(sym: Symbol, name: string, moduleName?: string, kind?: SymbolKind): void {
    this.stack[this.stack.length - 1].symbols.set(name, sym);
    if (moduleName != null) this.modules.set(sym, moduleName);
    if (kind != null) this.kinds.set(sym, kind);
  }

  /** Name of the module a recorded symbol was assembled in, if known. */
  moduleOf(sym: Symbol): string | undefined {
    return this.modules.get(sym);
  }

  /**
   * How the symbol was declared. `isLabel` alone can't tell an `.enum` member
   * from a plain `Foo = 5`, so the assembler tags the ones it knows and
   * everything else falls back to the label/constant split.
   */
  kindOf(sym: Symbol): SymbolKind {
    const tagged = this.kinds.get(sym);
    if (tagged) return tagged;
    return sym.isLabel ? 'label' : 'constant';
  }

  /** Walks every scope depth-first, root's children first, root itself last. */
  *walk(): Iterable<IndexedScope> {
    for (const child of this.root.children) yield* this.walkImpl(child);
    yield this.root;
  }

  private *walkImpl(scope: IndexedScope): Iterable<IndexedScope> {
    yield scope;
    for (const child of scope.children) yield* this.walkImpl(child);
  }

  /** Find a scope by its qualified name (e.g. `Foo::Bar`). */
  findScope(qualifiedName: string): IndexedScope | undefined {
    for (const scope of this.walk()) {
      if (scope.qualifiedName === qualifiedName) return scope;
    }
    return undefined;
  }

  /** Find the innermost scope whose source range contains the file/line position */
  scopeAt(file: string, line: number): IndexedScope | undefined {
    let best: IndexedScope | undefined;
    for (const scope of this.walk()) {
      if (!scope.start || scope.start.file !== file) continue;
      if (scope.start.line > line) continue;
      if (scope.end && scope.end.line < line) continue;
      // Most nested match wins.
      if (!best || scope.qualifiedName.length > best.qualifiedName.length) best = scope;
    }
    return best;
  }

  /** Find a symbol by name (qualified or simple). */
  findSymbol(name: string): {scope: IndexedScope, sym: Symbol} | undefined {
    for (const scope of this.walk()) {
      const sym = scope.symbols.get(name);
      if (sym) return {scope, sym};
    }
    return undefined;
  }
}