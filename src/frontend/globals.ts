// SPDX-License-Identifier: MPL-2.0

import type { Expr } from '../expr.ts';
import type * as mod from '../module.ts';
import type { ErrorCollector } from '../error.ts';
import { assertNever } from '../util.ts';
import { type Scope, type Symbol, bindForwardRef, firstRef } from './scope.ts';
import type { SourceInfo } from '../token.ts';
import type { LateContext } from './assembler.ts';

export type GlobalKind = 'export'|'import'|'global';

/** `.export`/`.import`/`.global` calls along with the scope it appeared in. */
interface GlobalDecl {
  scope: Scope;
  kind: GlobalKind;
  zeropage: boolean;
}

/** Imports, exports and globals, and how each resolves at module close. */
export class GlobalTable {
  /**
   * `.export`/`.import`/`.global` declarations
   * We track what scope they are created in because ca65 allows exports from within a
   * scope to export the sym as a global without scope.
   */
  private readonly globals = new Map<string, GlobalDecl[]>();
  private readonly resolvedGlobalKinds = new Map<string, 'import'|'export'>();
  /** Names a command-line `-D` defined, which an `.import` may take over. */
  private readonly commandLineDefines = new Set<string>();
  autoimportEnabled = true;
  /** Names turned into implicit imports, so we can blame them if unresolved. */
  readonly autoImported: mod.AutoImport[] = [];

  /** `late` is read live, since tests swap `linkEnv` after construction. */
  constructor(private readonly late: LateContext,
              private readonly lateAssemblyQueries: mod.LateAssemblySizeQuery[]) {}

  /** False when a weak `.global` defers to an existing declaration. */
  declare(ident: string, kind: GlobalKind, scope: Scope, weak = false,
          zeropage = false): boolean {
    const decls = this.globals.get(ident);
    const existing = decls?.find(d => d.scope === scope);
    // .global is replaced by an explicit .import/.export if they are in the same scope,
    // but if the .global is in an outer scope and .export is in an inner scope, they are
    // different. The .global should turn into an .import at close, and .export should still
    // export that sym.
    if (existing) {
      existing.zeropage ||= zeropage;
      if (weak) return false;
    }
    // Use the linker version of the -D cli define instead of the global .set version
    if (kind === 'import' && this.commandLineDefines.delete(ident)) {
      scope.global.symbols.delete(ident);
    }
    if (existing) {
      existing.kind = kind;
    } else if (decls) {
      decls.push({scope, kind, zeropage});
    } else {
      this.globals.set(ident, [{scope, kind, zeropage}]);
    }
    return true;
  }

  markCommandLineDefine(ident: string) {
    this.commandLineDefines.add(ident);
  }

  isZeropage(name: string, scope: Scope): boolean {
    return this.visibleDeclaration(name, scope)?.zeropage ?? false;
  }

  isImport(name: string, scope: Scope): boolean {
    return this.visibleDeclaration(name, scope)?.kind === 'import';
  }

  /** Declared from more than one scope, so the import/export pass resolves it. */
  isMultiScope(name: string): boolean {
    return (this.globals.get(name)?.length ?? 0) > 1;
  }

  kindInScope(name: string, scope: Scope): GlobalKind|undefined {
    return this.globals.get(name)?.find(decl => decl.scope === scope)?.kind;
  }

  /** linker's name for an explicit or implicit import reference. */
  importName(name: string, scope: Scope): string|undefined {
    if (this.isImport(name, scope)) return name.slice(name.lastIndexOf(':') + 1);
    if (this.late.autoImportNames?.has(name)) return name;
    return undefined;
  }

  private visibleDeclaration(name: string, from: Scope): GlobalDecl|undefined {
    const split = name.lastIndexOf('::');
    const qualified = split >= 0;
    const tail = qualified ? name.slice(split + 2) : name;
    const decls = this.globals.get(tail);
    if (!decls) return undefined;
    const start = qualified ? from.pickScope(name, undefined, 'undefined')?.[1] : from;
    for (let scope = start; scope; scope = qualified ? undefined : scope.parent) {
      const decl = decls.find(d => d.scope === scope);
      if (decl) return decl;
      if (scope.symbols.has(tail)) break;
    }
    return undefined;
  }

  /** The name of an unresolved `.import` reachable through +/- from `expr`, if any. */
  unresolvedImportIn(expr: Expr, scope: Scope): string|undefined {
    if (expr.op === 'sym' || expr.op === 'im') {
      const name = expr.sym;
      return name && !this.isZeropage(name, scope) ? this.importName(name, scope) : undefined;
    }
    if (expr.op === '+' || expr.op === '-') {
      for (const a of expr.args ?? []) {
        const name = this.unresolvedImportIn(a, scope);
        if (name) return name;
      }
    }
    return undefined;
  }

  /** In the late pass, turns a known import into its `im` expr. */
  lateImport(name: string, from: Scope, at?: SourceInfo, immediate = false): Expr|undefined {
    const linkEnv = this.late.linkEnv;
    if (!linkEnv) return undefined;
    const picked = from.pickScope(name, undefined, 'undefined');
    if (!picked) return undefined;
    const [tail, start] = picked;
    const allowParent = immediate && tail === name;
    for (let scope: Scope|undefined = start; scope;
         scope = allowParent ? scope.parent : undefined) {
      if (scope.symbols.has(tail)) return undefined;
      const decl = this.globals.get(tail)?.find(d => d.scope === scope);
      if (decl?.kind === 'import' ||
          (immediate && decl?.kind === 'global' && this.late.globalKinds?.[tail] === 'import')) {
        return this.importExpr(tail, at, decl.zeropage || linkEnv.addrSize(tail) === 1);
      }
      if (decl) return undefined;
    }
    if (immediate && tail === name && this.late.autoImportNames?.has(name)) {
      return this.importExpr(name, at, linkEnv.addrSize(name) === 1);
    }
    return undefined;
  }

  private importExpr(name: string, at: SourceInfo|undefined, zeropage: boolean): Expr {
    const expr: Expr = {op: 'im', sym: name};
    if (at) expr.source = at;
    if (zeropage) expr.meta = {size: 1};
    return expr;
  }

  /** Binds every declaration to its symbol at module close. */
  resolve(allocSymbol: (sym: Symbol) => Symbol, collector: ErrorCollector) {
    for (const [name, decls] of this.globals) {
      // Resolve the symbol in each scope the declaration appeared in - the
      // same name can be imported from multiple sibling scopes, and each
      // occurrence needs its own resolution against its own local symbol.
      for (const {scope, kind: global, zeropage} of decls) {
        let sym = scope.symbols.get(name) ?? scope.forwardRefs.get(name);
        // An export may publish a visible definition from an enclosing scope.
        // Imports and globals declare names in their own scope.
        for (let s = scope.parent; global === 'export' && s && sym == null; s = s.parent) {
          const outer = s.symbols.get(name);
          if (outer?.expr) sym = outer;
        }
        // `.global` is import-or-export depending on whether it got defined here.
        // Don't treat an eagerly resolved global export in the late pass as global if
        // we already know whether it was import or export from the first pass
        const kind = global === 'global' ?
            (sym?.expr && sym.expr.op !== 'im' ? 'export' : 'import') : global;
        if (global === 'global') this.resolvedGlobalKinds.set(name, kind);
        if (kind === 'export') {
          if (!sym?.expr) {
            collector.add('error', `Exported symbol '${name}' undefined`, firstRef(sym));
            continue;
          }
          if (sym.id == null) allocSymbol(sym);
          sym.export = name;
          // An `.export` inside a `.proc`/`.scope` publishes the name for the
          // whole module, so a reference from outside that scope - which by now
          // has been floated up to the global scope - names this symbol.
          const outer = scope.global.forwardRefs.get(name);
          if (outer && outer !== sym && !outer.expr) {
            bindForwardRef(outer, sym, scope.collectRefs);
          }
        } else if (kind === 'import') {
          if (!sym) continue; // okay to import but not use.
          // TODO - record both positions?
          // Already resolved by resolveSymbol during the latepass is not a redefinition
          if (sym.expr && sym.expr.op !== 'im') {
            collector.add('error', `Symbol '${name}' already defined`, firstRef(sym));
            continue;
          }
          sym.expr ??= this.importExpr(
              name, firstRef(sym), zeropage || this.late.linkEnv?.addrSize(name) === 1);
          if (scope.takeForwardRef(name)) scope.declare(name, sym);
        } else {
          assertNever(kind);
        }
      }
    }
  }

  /** Autoimports, or reports, whatever `scope` left undefined. */
  importUndefined(scope: Scope, collector: ErrorCollector) {
    for (const child of scope.children.values()) this.importUndefined(child, collector);
    for (const child of scope.anonymousChildren) this.importUndefined(child, collector);
    for (const [name, sym] of scope.forwardRefs) {
      if (sym.expr) continue;
      if (this.autoimportEnabled) {
        this.autoImport(name, sym);
        scope.declare(name, sym);
      } else {
        collector.add('error', `Symbol '${name}' undefined`, firstRef(sym));
      }
    }
    scope.forwardRefs.clear();
  }

  /** Converts undefined syms into imports */
  private autoImport(name: string, sym: Symbol) {
    const expr: Expr = {op: 'im', sym: name};
    const at = firstRef(sym);
    if (at) expr.source = at;
    const answer = this.late.linkEnv?.addrSize(name);
    if (answer != null) {
      if (answer === 1) expr.meta = {size: 1};
    } else {
      // First pass: the operands referencing this name were already emitted at
      // the abs guess, so ask the linker to re-run us if it knows better.
      this.lateAssemblyQueries.push({name, guess: 2, source: at});
    }
    sym.expr = expr;
    this.autoImported.push({name, source: at});
  }

  resolvedKinds(): Record<string, 'import'|'export'> {
    return Object.fromEntries(this.resolvedGlobalKinds);
  }
}
