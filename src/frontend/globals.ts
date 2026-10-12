// SPDX-License-Identifier: MPL-2.0

import type { Expr } from '../expr.ts';
import type * as mod from '../module.ts';
import type { ErrorCollector } from '../error.ts';
import { assertNever } from '../util.ts';
import { type Scope, type Symbol, firstRef } from './scope.ts';
import type { LateContext } from './assembler.ts';

export type GlobalKind = 'export'|'import'|'global';

/** `.export`/`.import`/`.global` calls along with the scope it appeared in. */
interface GlobalDecl {
  scope: Scope;
  kind: GlobalKind;
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
  /** Symbols declared zeropage (.importzp/.exportzp/.globalzp) */
  private readonly zeropageGlobals = new Set<string>();
  /** Names a command-line `-D` defined, which an `.import` may take over. */
  private readonly commandLineDefines = new Set<string>();
  autoimportEnabled = true;
  /** Names turned into implicit imports, so we can blame them if unresolved. */
  readonly autoImported: mod.AutoImport[] = [];

  /** `late` is read live, since tests swap `linkEnv` after construction. */
  constructor(private readonly late: LateContext,
              private readonly lateAssemblyQueries: mod.LateAssemblySizeQuery[]) {}

  /** False when a weak `.global` defers to an existing declaration. */
  declare(ident: string, kind: GlobalKind, scope: Scope, weak = false): boolean {
    const decls = this.globals.get(ident);
    const existing = decls?.find(d => d.scope === scope);
    // .global is replaced by an explicit .import/.export if they are in the same scope,
    // but if the .global is in an outer scope and .export is in an inner scope, they are
    // different. The .global should turn into an .import at close, and .export should still
    // export that sym.
    if (existing && weak) return false;
    // Use the linker version of the -D cli define instead of the global .set version
    if (kind === 'import' && this.commandLineDefines.delete(ident)) {
      scope.global.symbols.delete(ident);
    }
    if (existing) {
      existing.kind = kind;
    } else if (decls) {
      decls.push({scope, kind});
    } else {
      this.globals.set(ident, [{scope, kind}]);
    }
    return true;
  }

  markZeropage(ident: string) {
    this.zeropageGlobals.add(ident);
  }

  isZeropage(name: string): boolean {
    return this.zeropageGlobals.has(name);
  }

  markCommandLineDefine(ident: string) {
    this.commandLineDefines.add(ident);
  }

  /** True if any declaration of `name` anywhere in the module has this kind. */
  hasGlobalKind(name: string, kind: GlobalKind): boolean {
    return this.globals.get(name)?.some(d => d.kind === kind) ?? false;
  }

  /** Declared from more than one scope, so the import/export pass resolves it. */
  isMultiScope(name: string): boolean {
    return (this.globals.get(name)?.length ?? 0) > 1;
  }

  /** True if explicitly imported or autoimported */
  isImportRef(name: string): boolean {
    return this.hasGlobalKind(name, 'import') ||
        Boolean(this.late.autoImportNames?.has(name));
  }

  /** The name of an unresolved `.import` reachable through +/- from `expr`, if any. */
  unresolvedImportIn(expr: Expr): string|undefined {
    if (expr.op === 'sym' || expr.op === 'im') {
      const name = expr.sym;
      return name && this.isImportRef(name) && !this.zeropageGlobals.has(name) ?
          name : undefined;
    }
    if (expr.op === '+' || expr.op === '-') {
      for (const a of expr.args ?? []) {
        const name = this.unresolvedImportIn(a);
        if (name) return name;
      }
    }
    return undefined;
  }

  /** In the late pass, turns a known import into its `im` expr. */
  lateImport(name: string, sym: Symbol): Expr|undefined {
    const linkEnv = this.late.linkEnv;
    if (!linkEnv) return undefined;
    const declared = this.globals.has(name);
    if (!(this.hasGlobalKind(name, 'import') ||
        (this.hasGlobalKind(name, 'global') &&
            this.late.globalKinds?.[name] === 'import') ||
        (!declared && this.late.autoImportNames?.has(name)))) {
      return undefined;
    }
    const expr: Expr = {op: 'im', sym: name};
    const at = firstRef(sym);
    if (at) expr.source = at;
    if (this.zeropageGlobals.has(name) || linkEnv.addrSize(name) === 1) {
      expr.meta = {size: 1};
    }
    sym.expr = expr;
    return expr;
  }

  /** Binds every declaration to its symbol at module close. */
  resolve(allocSymbol: (sym: Symbol) => Symbol, collector: ErrorCollector) {
    for (const [name, decls] of this.globals) {
      // Resolve the symbol in each scope the declaration appeared in - the
      // same name can be imported from multiple sibling scopes, and each
      // occurrence needs its own resolution against its own local symbol.
      for (const {scope, kind: global} of decls) {
        let sym = scope.symbols.get(name);
        // Try to walk the sym scope looking for the sym, but ONLY while we don't
        // already have something. This lets it choose a scoped import over an import
        // with the same name in the parent scope.
        for (let s = scope.parent; s && sym == null; s = s.parent) {
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
          const outer = scope.global.symbols.get(name);
          if (outer && outer !== sym && !outer.expr) {
            outer.expr = {op: 'sym', num: sym.id!};
          }
        } else if (kind === 'import') {
          if (!sym) continue; // okay to import but not use.
          // TODO - record both positions?
          // Already resolved by resolveSymbol during the latepass is not a redefinition
          if (sym.expr && sym.expr.op !== 'im') {
            collector.add('error', `Symbol '${name}' already defined`, firstRef(sym));
            continue;
          }
          if (!sym.expr) {
            // Zeropage imports carry a one-byte size so references pick zp modes.
            const expr: Expr = {op: 'im', sym: name};
            // Carry the reference site so the linker can point at something if the
            // import turns out never to have been exported.
            const at = firstRef(sym);
            if (at) expr.source = at;
            if (this.zeropageGlobals.has(name)) expr.meta = {size: 1};
            sym.expr = expr;
          }
        } else {
          assertNever(kind);
        }
      }
    }
  }

  /** Autoimports, or reports, whatever `scope` left undefined. */
  importUndefined(scope: Scope, collector: ErrorCollector) {
    for (const [name, sym] of scope.symbols) {
      if (sym.expr) continue;
      if (this.autoimportEnabled) {
        this.autoImport(name, sym);
      } else {
        collector.add('error', `Symbol '${name}' undefined`, firstRef(sym));
      }
    }
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
