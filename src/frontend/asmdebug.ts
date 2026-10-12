// SPDX-License-Identifier: MPL-2.0

import type { Expr } from '../expr.ts';
import * as mod from '../module.ts';
import type { ErrorCollector } from '../error.ts';
import type { Token } from '../token.ts';
import type * as Tokens from '../token.ts';
import { DATA_ELEMENTS, DebugBuilder, type ExtLine, arrayType } from './debugtables.ts';
import { SIZE_NAME, SIZE_SUFFIX, type Scope, type Symbol, isSizeOfSymbol } from './scope.ts';
import type { GlobalKind } from './globals.ts';

export function chainDepth(source?: Tokens.SourceInfo): number {
  let depth = 0;
  for (let s = source?.parent; s; s = s.parent) depth++;
  return depth;
}

function deepestSource(tokens: Token[]): Tokens.SourceInfo|undefined {
  let best: Tokens.SourceInfo|undefined;
  let bestDepth = -1;
  for (const {source} of tokens) {
    if (!source) continue;
    const depth = chainDepth(source);
    if (depth > bestDepth) {
      best = source;
      bestDepth = depth;
    }
  }
  return best;
}

/** A `.dbg func` or `.dbg sym`, kept until the module ends. */
export interface PendingCSym {
  name: string;
  type: string;
  sc: mod.DebugCSym['sc'];
  scope: Scope;
  offs?: number;
  asmName?: string;
  func?: boolean;
  source?: Tokens.SourceInfo;
}

/** Where the next byte would land before a statement. */
export interface EmitMark {
  chunk?: mod.ChunkNum;
  length: number;
  chunks: number;
}

export interface DebugHost {
  lookupSymbol(name: string): Symbol|undefined;
  resolve(expr: Expr): Expr;
  isZeropageGlobal(name: string): boolean;
  isImport(name: string): boolean;
  readonly errorCollector: ErrorCollector;
}

/** Debug-only state of one module, for the `.dbg` and MLB writers. */
export class AssemblyDebug {
  readonly tables = new DebugBuilder();
  /** The current statement's source with the deepest macro chain. */
  source?: Tokens.SourceInfo;
  /** Element type of the data directive being assembled, for span types. */
  private dataElement?: {size: number, type: string};
  /** Whether the statement being assembled emitted an instruction. */
  emittedCode = false;
  /** ca65 `.debuginfo`; the value at the end of the module wins. */
  debugSyms = true;

  /** Symbols defined in this module, as opposed to references that resolved. */
  private readonly definedSyms = new Set<Symbol>();
  private readonly cheapSyms: Array<{name: string, sym: Symbol, parent?: Symbol}> = [];
  /** Token of every assignment of a `.set` symbol. */
  private readonly setDefs = new Map<Symbol, Tokens.SourceInfo[]>();
  /** Statement each definition came from, with the `.dbg line` open there. */
  private readonly defLines = new Map<Symbol, Array<{src: Tokens.SourceInfo, ext?: ExtLine}>>();
  /** Where each `.import`/`.global` name was first declared, its def for ca65. */
  private readonly globalDecls = new Map<string, Tokens.SourceInfo>();
  /** Each `.export` of a name, which ca65 counts as a ref. */
  private readonly exportSites = new Map<string, Tokens.SourceInfo[]>();
  /** Conditional refs to names not defined yet. */
  private readonly pendingCondRefs: Array<{name: string, scope: Scope, source: Tokens.SourceInfo}> = [];
  /** The last non-cheap label, which owns the cheap locals after it. */
  private lastLabel?: Symbol;
  private anonScopeCount = 0;
  /** Enum members and labels on a macro call line, which ca65 gives no size. */
  private readonly unsizedSyms = new Set<Symbol>();
  /** `.dbg func`/`.dbg sym` entries, whose asm symbols resolve at the end. */
  private readonly csyms: PendingCSym[] = [];
  /** Debug labels for anonymous/temp labels that aren't in normal symbol tables. */
  private readonly debugLabels: Array<{name: string, expr: Expr}> = [];

  constructor(moduleName: string|undefined, private readonly host: DebugHost) {
    if (moduleName) this.tables.fileId(moduleName);
  }

  startLine(tokens: Token[]) {
    this.source = deepestSource(tokens);
  }

  /** Keeps a line record for a line ca65 holds on to, such as a conditional. */
  noteLine(src?: Tokens.SourceInfo) {
    if (src) this.tables.lineChain(src);
  }

  directive(name: string) {
    this.dataElement = DATA_ELEMENTS.get(name);
  }

  markEmitted(chunk: mod.ChunkNum|undefined, chunks: number): EmitMark {
    this.dataElement = undefined;
    this.emittedCode = false;
    return {chunk, length: chunk?.data.length ?? 0, chunks};
  }

  /** Attributes the bytes a statement emitted to its source lines. */
  recordRun(before: EmitMark, chunk: mod.ChunkNum|undefined, chunkIndex: number,
            src: Tokens.SourceInfo|undefined, scope: Scope) {
    if (!chunk || !src) return;
    // A chunk that already existed and was not current before is a `.popseg`.
    if (chunk !== before.chunk && chunkIndex < before.chunks) return;
    const start = chunk === before.chunk ? before.length : 0;
    const size = chunk.data.length - start;
    if (size <= 0) return;
    const dbg = this.tables;
    const elem = this.dataElement;
    const type = elem && size % elem.size === 0 ?
        dbg.typeId(arrayType(size / elem.size, elem.type)) :
        this.emittedCode ? mod.DEBUG_RUN_CODE : mod.DEBUG_RUN_UNTYPED;
    if (start === 0 && !chunk.source) chunk.source = src;
    dbg.addRun(chunk, start, size, dbg.lineSet(this.source ?? src), type);
    const runs = scope.debugRuns ??= [];
    const last = runs[runs.length - 1];
    if (last && last[0] === chunkIndex && last[1] + last[2] === start) {
      last[2] += size;
    } else {
      runs.push([chunkIndex, start, size]);
    }
  }

  /** ca65 counts every symbol in a conditional as a ref, even forward ones. */
  conditionRefs(expr: Expr, at: Tokens.SourceInfo|undefined, scope: Scope) {
    const walk = (e: Expr) => {
      if (e.op === '.sizeof') return;
      const source = e.source ?? at;
      if (e.op === 'sym' && e.sym && e.sym !== '*' && source) {
        const sym = this.host.lookupSymbol(e.sym);
        if (sym) {
          (sym.refs ??= []).push(source);
        } else if (!e.sym.startsWith('@') && !e.sym.includes('::')) {
          this.pendingCondRefs.push({name: e.sym, scope, source});
        }
      }
      e.args?.forEach(walk);
    };
    walk(expr);
  }

  /** A label whose line ran into a macro gets no size, as in ca65. */
  closeLabelSpan(depth: number, sym: Symbol|undefined) {
    if (sym && chainDepth(this.source) > depth) this.unsizedSyms.add(sym);
  }

  markUnsized(sym: Symbol|undefined) {
    if (sym) this.unsizedSyms.add(sym);
  }

  anonLabel(dir: '+'|'-', expr: Expr) {
    this.debugLabels.push({name: dir === '+' ? '@p' : '@m', expr});
  }

  setLastLabel(sym: Symbol|undefined) {
    this.lastLabel = sym;
  }

  define(ident: string, sym: Symbol, expr: Expr, mut: boolean, isLabel: boolean,
         token?: Tokens.SourceInfo) {
    const isCheapLocal = ident.startsWith('@');
    this.definedSyms.add(sym);
    const at = this.source ?? token;
    if (at) {
      const def = {src: at, ext: this.tables.ext};
      this.defLines.set(sym, mut ? [...this.defLines.get(sym) ?? [], def] : [def]);
    }
    if (mut && token) {
      const defs = this.setDefs.get(sym) ?? [];
      defs.push(token);
      this.setDefs.set(sym, defs);
    }
    if (isCheapLocal && isLabel && !mut) {
      this.cheapSyms.push({name: ident, sym, parent: this.lastLabel});
    }
    // Add cheap locals to debugLabels for MLB output.  Constant assignments
    // (`@temp = $05`) aren't positions, so they'd only add bogus entries.
    if (isCheapLocal && isLabel) this.debugLabels.push({name: ident, expr});
  }

  declareGlobal(ident: string, kind: GlobalKind, source?: Tokens.SourceInfo) {
    this.noteLine(this.source);
    if (!source) return;
    if (kind === 'export') {
      const sites = this.exportSites.get(ident) ?? [];
      sites.push(source);
      this.exportSites.set(ident, sites);
    } else if (!this.globalDecls.has(ident)) {
      this.globalDecls.set(ident, source);
    }
  }

  nextAnonScope(): number {
    return ++this.anonScopeCount;
  }

  hasFunc(scope: Scope): boolean {
    return this.csyms.some(c => c.func && c.scope === scope);
  }

  addCSym(csym: PendingCSym) {
    this.csyms.push(csym);
  }

  /** Assembles the scope, symbol and line tables the `.dbg` writer reads. */
  build(global: Scope): mod.Debug {
    const dbg = this.tables;
    for (const {name, scope, source} of this.pendingCondRefs) {
      for (let s: Scope|undefined = scope; s; s = s.parent) {
        const sym = s.symbols.get(name);
        if (!sym?.expr) continue;
        (sym.refs ??= []).push(source);
        break;
      }
    }
    const scopes: mod.DebugScope[] = [];
    const syms: mod.DebugSym[] = [];
    const scopeIds = new Map<Scope, number>();
    const symIds = new Map<Symbol, number>();
    const order: Scope[] = [];

    const sizeOf = (expr?: Expr): number|undefined => {
      if (!expr) return undefined;
      try {
        const r = this.host.resolve(expr);
        return r.op === 'num' ? r.num : undefined;
      } catch {
        return undefined;
      }
    };

    // A scope's bytes include everything in the scopes nested inside it.
    const gather = (scope: Scope, out: mod.DebugScopeRun[]) => {
      if (scope.debugRuns) out.push(...scope.debugRuns);
      for (const child of scope.children.values()) {
        if (!child.forwardDeclared) gather(child, out);
      }
      for (const child of scope.anonymousChildren) gather(child, out);
    };
    const merged = (runs: mod.DebugScopeRun[]) => {
      runs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      const out: mod.DebugScopeRun[] = [];
      for (const run of runs) {
        const last = out[out.length - 1];
        if (last && last[0] === run[0] && last[1] + last[2] === run[1]) {
          last[2] += run[2];
        } else {
          out.push([run[0], run[1], run[2]]);
        }
      }
      return out;
    };
    const visit = (scope: Scope, parent?: number) => {
      const id = scopes.length;
      scopeIds.set(scope, id);
      order.push(scope);
      const data = !scope.dbgType;
      const runs = data ? merged((() => {
        const all: mod.DebugScopeRun[] = [];
        gather(scope, all);
        return all;
      })()) : [];
      const entry: mod.DebugScope = {
        name: scope.name ??
            (scope.anonId ?
                `$anon-SCOPE-${scope.anonId.toString(16).toUpperCase().padStart(4, '0')}` : ''),
        size: scope.dbgType === 'enum' ? 0 :
            sizeOf(scope.symbols.get(SIZE_NAME)?.expr) ??
            runs.reduce((n, r) => n + r[2], 0),
        runs,
      };
      if (parent !== undefined) {
        entry.parent = parent;
        entry.type = scope.dbgType ?? 'scope';
      }
      scopes.push(entry);
      for (const child of scope.children.values()) {
        if (!child.forwardDeclared) visit(child, id);
      }
      for (const child of scope.anonymousChildren) visit(child, id);
    };
    visit(global);

    const addrSize = (name: string, sym: Symbol): mod.DebugAddrSize => {
      const expr = sym.expr!;
      if (expr.op === 'im') return this.host.isZeropageGlobal(name) ? 'zeropage' : 'absolute';
      if (expr.op === 'num' && !expr.meta?.rel) {
        const n = expr.num!;
        if (n >= 0 && n < 0x100) return 'zeropage';
        if (n >= 0 && n < 0x10000) return 'absolute';
        return n >= 0 && n < 0x1000000 ? 'far' : 'long';
      }
      return expr.meta?.zeropage || expr.meta?.size === 1 ? 'zeropage' : 'absolute';
    };
    const entryFor = (name: string, sym: Symbol): mod.DebugSym => {
      const expr = sym.expr!;
      const out: mod.DebugSym = {
        name,
        addrsize: addrSize(name, sym),
        expr,
        kind: expr.op === 'im' ? 'imp' : sym.isLabel ? 'lab' : 'equ',
      };
      if (sym.export != null) out.export = true;
      const decl = expr.op === 'im' ? this.globalDecls.get(name) : undefined;
      const defLines = this.defLines.get(sym) ??
          (sym.def ? [{src: sym.def}] : decl ? [{src: decl}] : []);
      const defs = defLines.flatMap(({src, ext}) => dbg.fullChain(src, ext));
      if (defs.length) out.defs = defs;
      // A definition resolves its own name, which ca65 does not count as a ref.
      const defTokens = this.setDefs.get(sym) ?? (sym.def ? [sym.def] : []);
      const refs = [
        ...(sym.refs ?? []).filter(r => !defTokens.some(
            d => d.file === r.file && d.line === r.line && d.column === r.column)),
        ...(sym.export != null ? this.exportSites.get(name) ?? [] : []),
      ].map(r => dbg.asmLine(r));
      if (refs.length) out.refs = refs;
      return out;
    };

    for (const scope of order) {
      const scopeId = scopeIds.get(scope)!;
      for (const [name, sym] of scope.symbols) {
        if (isSizeOfSymbol(name) || !sym.expr || symIds.has(sym)) continue;
        if (!this.definedSyms.has(sym) && sym.expr.op !== 'im') continue;
        const entry = entryFor(name, sym);
        entry.scope = scopeId;
        const size = this.unsizedSyms.has(sym) ? undefined :
            sizeOf(scope.symbols.get(`${name}${SIZE_SUFFIX}`)?.expr);
        if (size) entry.size = size;
        symIds.set(sym, syms.length);
        syms.push(entry);
      }
    }
    for (const {name, sym, parent} of this.cheapSyms) {
      const parentId = parent && symIds.get(parent);
      if (parentId === undefined || !sym.expr) continue;
      const entry = entryFor(name, sym);
      entry.parent = parentId;
      syms.push(entry);
    }
    // A `.proc` names the label it hangs off.
    for (const scope of order) {
      if (!scope.label || !scope.parent) continue;
      const label = scope.parent.symbols.get(scope.label);
      const id = label && symIds.get(label);
      if (id !== undefined) scopes[scopeIds.get(scope)!].label = id;
    }

    const hll = this.csyms.map(c => {
      const out: mod.DebugCSym = {
        name: c.name, scope: scopeIds.get(c.scope) ?? 0, type: c.type, sc: c.sc,
      };
      if (c.offs) out.offs = c.offs;
      const sym = c.asmName === undefined ? undefined : c.func ?
          c.scope.parent?.symbols.get(c.asmName) : this.findAnySymbol(c);
      const id = sym && symIds.get(sym);
      if (id !== undefined) out.sym = id;
      return out;
    });

    const files = dbg.files, lines = dbg.lines, lineSets = dbg.lineSets, types = dbg.types;
    if (!this.debugSyms) {
      return {files, lines, lineSets, types, scopes: [], syms: [], hll: [], lineOnly: true};
    }
    return {files, lines, lineSets, types, scopes, syms, hll};
  }

  private findAnySymbol(c: PendingCSym): Symbol|undefined {
    for (let s: Scope|undefined = c.scope; s; s = s.parent) {
      const sym = s.symbols.get(c.asmName!);
      if (sym?.expr) return sym;
    }
    // An import nothing uses exists, but has no debug sym.
    if (this.host.isImport(c.asmName!)) return undefined;
    this.host.errorCollector.add('error', `Assembler symbol '${c.asmName}' not found`, c.source);
    return undefined;
  }

  /** Collect all symbols from all scopes for the MLB writer. */
  mlbSymbols(global: Scope): mod.Symbol[] {
    const debugSymbols: mod.Symbol[] = [];
    let tempLabelCounter = 0;
    const usedNames = new Set<string>();

    // Helper to create unique name with _<IDX> suffix for temp/anonymous labels
    const makeUniqueName = (baseName: string): string => {
      let uniqueName = `${baseName}_${tempLabelCounter}`;
      while (usedNames.has(uniqueName)) {
        tempLabelCounter++;
        uniqueName = `${baseName}_${tempLabelCounter}`;
      }
      usedNames.add(uniqueName);
      tempLabelCounter++;
      return uniqueName;
    };

    const collectSymbols = (scope: Scope) => {
      for (const [name, sym] of scope.symbols) {
        // skip adding size symbols to the exported module since its not really a symbol
        if (isSizeOfSymbol(name)) continue;
        // skip adding syms defined with `=` and not `:=`
        if (!sym.isLabel) continue;
        if (sym.expr != null) {
          const expr = {...sym.expr};

          // De-anonymize temp labels by creating unique names with _<IDX> suffix
          if (name.startsWith('@')) {
            const baseName = name.substring(1).replace(':', '');
            expr.sym = makeUniqueName(baseName);
          } else {
            if (!expr.sym) {
              expr.sym = name;
            }
            // Track global names to avoid conflicts with temp labels
            usedNames.add(expr.sym);
          }

          debugSymbols.push({expr});
        }
      }
      for (const child of scope.children.values()) {
        collectSymbols(child);
      }
      for (const child of scope.anonymousChildren) {
        collectSymbols(child);
      }
    };
    collectSymbols(global);

    // Add cheap local and anonymous labels from debugLabels array
    for (const {name, expr: originalExpr} of this.debugLabels) {
      const expr = {...originalExpr};
      // All entries in debugLabels start with @ (temp labels like @loop, anonymous like @p/@m)
      const baseName = name.substring(1).replace(':', ''); // Remove @ prefix and any colons
      expr.sym = makeUniqueName(baseName);
      debugSymbols.push({expr});
    }
    return debugSymbols;
  }
}
