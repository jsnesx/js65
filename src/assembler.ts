// SPDX-License-Identifier: MPL-2.0

import { Base64 } from './base64.ts';
import { Cpu } from './cpu.ts';
import { type Expr } from './expr.ts';
import * as Exprs from './expr.ts';
import * as mod from './module.ts';
import { type Token, type AssemblerMessage, type ErrorLevel } from './token.ts'
import * as Tokens from './token.ts';
import { Tokenizer } from './tokenizer.ts';
import { IntervalSet, assertNever } from './util.ts';

type Chunk = mod.ChunkNum; //<number[]>;
type Module = mod.Module;

export class Symbol {
  /**
   * Index into the global symbol array.  Only applies to immutable
   * symbols that need to be accessible at link time.  Mutable symbols
   * and symbols with known values at use time are not added to the
   * global list and are therefore have no id.  Mutability is tracked
   * by storing a -1 here.
   */
  id?: number;
  /** Whether the symbol has been explicitly scoped. */
  scoped?: boolean;
  /**
   * The expression for the symbol.  Must be a statically-evaluatable constant
   * for mutable symbols.  Undefined for forward-referenced symbols.
   */
  expr?: Expr;
  /** Name this symbol is exported as. */
  export?: string;
  /** Token where this symbol was ref'd. */
  ref?: {source?: Tokens.SourceInfo}; // TODO - plumb this through
}

interface ResolveOpts {
  // Whether to create a forward reference for missing symbols.
  allowForwardRef?: boolean;
  // Reference Tokens.
  ref?: {source?: Tokens.SourceInfo};
}

interface FwdRefResolveOpts extends ResolveOpts {
  allowForwardRef: true;
}

abstract class BaseScope {
  //closed = false;
  readonly symbols = new Map<string, Symbol>();

  protected pickScope(name: string): [string, BaseScope] {
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
    const [tail, scope] = this.pickScope(name);
    const sym = scope.symbols.get(tail);
//console.log('resolve:',name,'sym=',sym,'fwd?',allowForwardRef);
    if (sym) {
      if (tail !== name) sym.scoped = true;
      return sym;
    }
    if (!allowForwardRef) return undefined;
    // if (scope.closed) throw new Error(`Could not resolve symbol: ${name}`);
    // make a new symbol - but only in an open scope
    //const symbol = {id: this.symbolArray.length};
//console.log('created:',symbol);
    //this.symbolArray.push(symbol);
    const symbol: Symbol = {ref};
    scope.symbols.set(tail, symbol);
    if (tail !== name) symbol.scoped = true;
    return symbol;
  }
}

class Scope extends BaseScope {
  readonly global: Scope;
  readonly children = new Map<string, Scope>();
  readonly anonymousChildren: Scope[] = [];

  constructor(readonly parent?: Scope, readonly kind?: 'scope'|'proc') {
    super();
    this.global = parent ? parent.global : this;
  }

  pickScope(name: string): [string, Scope] {
    // TODO - plumb the source information through here?
    // deno-lint-ignore no-this-alias
    let scope: Scope = this;
    const split = name.split(/::/g);
    const tail = split.pop()!;
    for (let i = 0; i < split.length; i++) {
      if (!i && !split[i]) { // global
        scope = scope.global;
        continue;
      }
      let child = scope.children.get(split[i]);
      while (!i && scope.parent && !child) {
        child = (scope = scope.parent).children.get(split[i]);
      }
      // If the name has an explicit scope, this is an error?
      if (!child) {
        const scopeName = split.slice(0, i + 1).join('::');
        throw new Error(`Could not resolve scope ${scopeName}`);
      }
      scope = child;
    }
    return [tail, scope];
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

class CheapScope extends BaseScope {

  /** Clear everything out, making sure everything was defined. */
  clear() {
    this.validate();
    this.symbols.clear();
  }
  validate() {
    for (const [name, sym] of this.symbols) {
      if (!sym.expr) {
        const at = sym.ref ? Tokens.at(sym.ref) : '';
        throw new Error(`Cheap local label never defined: ${name}${at}`);
      }
    }
  }
}

export interface RefExtractor {
  label?(name: string, addr: number, segments: readonly string[]): void;
  ref?(expr: Expr, bytes: number, addr: number, segments: readonly string[]): void;
  assign?(name: string, value: number): void;
}

export class RecoverableError extends Tokens.SourceError {
  constructor(message: string, source?: Tokens.SourceInfo) {
    super(message, source);
    this.name = 'RecoverableError';
  }
}

export class ErrorCollector {
  private messages: AssemblerMessage[] = [];

  add(level: ErrorLevel, message: string, source?: Tokens.SourceInfo): void {
    this.messages.push({
      level,
      message,
      source,
      stack: new Error().stack,
    });
  }

  addFromException(err: Error, source?: Tokens.SourceInfo, level: ErrorLevel = 'error'): void {
    this.messages.push({
      level,
      message: err.message,
      source: (err instanceof Tokens.SourceError ? err.source : undefined) ?? source,
      stack: err.stack,
    });
  }

  getMessages(): readonly AssemblerMessage[] {
    return this.messages;
  }

  hasErrors(): boolean {
    return this.messages.some(m => m.level === 'error');
  }

  clear(): void {
    this.messages = [];
  }
}

export class Assembler {

  /** The currently-open segment(s). */
  private segments: /* readonly */ string[] = [];

  /** Data on all the segments. */
  private segmentData = new Map<string, mod.Segment>();

  /** Stack of segments for .pushseg/.popseg. */
  private segmentStack: Array<readonly [/* readonly */ string[], Chunk?]> = [];

  /** All symbols in this object. */
  private symbols: Symbol[] = [];

  /** Global symbols. `.global` resolves to import or export at close time
   *  depending on whether the symbol ends up defined in this module. */
  // NOTE: we could add 'force-import', 'detect', or others...
  private globals = new Map<string, 'export'|'import'|'global'>();
  /** Scope each `.export`/`.import`/`.global` was declared in, so the symbol is
   *  resolved there. */
  private globalScopes = new Map<string, Scope>();
  /** Symbols declared zeropage (.importzp/.exportzp/.globalzp) */
  private zeropageGlobals = new Set<string>();

  /** Current state for tracking .struct and .enum members */
  private structContext: Array<{kind: 'struct'|'enum', offset: number, name?: string}> = [];

  /** Mapping for any string to byte array  */
  private charMapping = new Map<string, number[]>();
  /** Saved charmaps for `.pushcharmap`/`.popcharmap`. */
  private charmapStack: Array<Map<string, number[]>> = [];

  /** The current scope. */
  private currentScope = new Scope();

  /** A scope for cheap local labels. */
  private cheapLocals = new CheapScope();

  /** List of global symbol indices used by forward refs to anonymous labels. */
  private anonymousForward: number[] = [];

  /** List of chunk/offset positions of previous anonymous labels. */
  private anonymousReverse: Expr[] = [];

  /** Map of global symbol incides used by forward refs to relative labels. */
  private relativeForward: number[] = [];

  /** Map of chunk/offset positions of back-referable relative labels. */
  private relativeReverse: Expr[] = [];

  /** List of global symbol indices used by forward refs to rts statements. */
  private rtsRefsForward: number[] = [];

  /** List of chunk/offset positions of back-referable rts statements. */
  private rtsRefsReverse: Expr[] = [];

  /** All the chunks so far. */
  private chunks: Chunk[] = [];

  /** Set of offsets definitely written/freed so far. */
  private written = new IntervalSet();

  /** Currently active chunk */
  private _chunk: Chunk|undefined = undefined;

  /** Name of the next chunk */
  private _name: string|undefined = undefined;

  /** Origin of the currnet chunk, if fixed. */
  private _org: number|undefined = undefined;

  /** Alignment constraint to stamp on the next chunk, from a pending `.align`. */
  private _pendingAlign: number|undefined = undefined;
  /** TODO: use this to actually fill the alignment later. */
  private _pendingFill: number|undefined = undefined;

  /** Prefix to prepend to all segment names. */
  private _segmentPrefix = '';

  /** Current source location, for error messages. */
  private _source?: Tokens.SourceInfo;

  /** Debug labels for anonymous/temp labels that aren't in normal symbol tables. */
  private debugLabels: Array<{name: string, expr: Expr}> = [];

  /** Token for reporting errors. */
  private errorToken?: Token;

  /** Collector for errors and messages */
  readonly errorCollector = new ErrorCollector();

  /** Supports refExtractor. */
  private _exprMap?: WeakMap<Expr, Expr> = undefined;

  /** 
   * When defining segments, this tracks the current offset in the output file
   * That way users don't have to define segment offsets if they are sequential
   */
  private _segmentOffset = 0;

  constructor(readonly cpu = Cpu.P02, readonly opts: Options = {}) {}

  /** Sets the current source location for debug info from an external source. */
  setSource(source?: Tokens.SourceInfo) {
    this._source = source;
  }

  private get chunk(): Chunk {
    // make chunk only when needed
    this.ensureChunk();
    return this._chunk!;
  }

  get exprMap() {
    return this._exprMap || (this._exprMap = new WeakMap());
  }

  get overwriteMode() {
    return this.opts.overwriteMode || 'allow';
  }

  private ensureChunk() {
    if (!this._chunk) {
      // NOTE: multiple segments OK if disjoint memory...
      // if (this._org != null && this.segments.length !== 1) {
      //   this.fail(`.org chunks must be single-segment`);
      // }
      this._chunk = {segments: this.segments, data: []};
      if (this._org != null) this._chunk.org = this._org;
      if (this._name) this._chunk.name = this._name;
      if (this._pendingAlign != null) {
        this._chunk.align = this._pendingAlign;
        this._pendingAlign = undefined;
        this._pendingFill = undefined;
      }
      this.chunks.push(this._chunk);
      this._chunk.overwrite = this.overwriteMode;

      // Initialize debug info tracking if enabled
      if (this.opts.generateDebugInfo) {
        this._chunk.sourceMap = new Map();
        this._chunk.labelIndex = new Map();
      }
    }
  }

  definedSymbol(sym: string): boolean {
    // In this case, it's okay to traverse up the scope chain since if we
    // were to reference the symbol, it's guaranteed to be defined somehow.
    if (this.globals.get(sym) === 'import') return true;
    let scope: Scope|undefined = this.currentScope;
    const unscoped = !sym.includes('::');
    do {
      const s = scope.resolve(sym, {allowForwardRef: false});
      if (s) return Boolean(s.expr);
    } while (unscoped && (scope = scope.parent));
    return false;
  }

  constantSymbol(sym: string): boolean {
    // If there's a symbol in a different scope, it's not actually constant.
    const s = this.currentScope.resolve(sym, {allowForwardRef: false});
    return Boolean(s && s.expr && !(s.id! < 0));
  }

  referencedSymbol(sym: string): boolean {
    // If not referenced in this scope, we don't know which it is...
    // NOTE: this is different from ca65.
    const s = this.currentScope.resolve(sym, {allowForwardRef: false});
    return s != null; // NOTE: this counts definitions.
  }

  evaluate(expr: Expr): number|undefined {
    expr = this.resolve(expr);
    if (expr.op === 'num' && !expr.meta?.rel) return expr.num;
    return undefined;
  }

  // private get pc(): number|undefined {
  //   if (this._org == null) return undefined;
  //   return this._org + this.offset;
  // }

  pc(): Expr {
    const num = this.chunk.data.length; // NOTE: before counting chunks
    const meta: Exprs.Meta = {rel: true, chunk: this.chunks.length - 1};
    if (this._chunk?.org != null) meta.org = this._chunk.org;
    return Exprs.evaluate({op: 'num', num, meta});
  }

  // Returns an expr resolving to a symbol name (e.g. a label)
  symbol(name: string): Expr {
    return Exprs.evaluate(Exprs.parseOnly([{token: 'ident', str: name}], 0, this.currentScope.symbols));
  }

  where(): string {
    if (!this._chunk) return '';
    if (this.chunk.org == null) return '';
    return `${this.chunk.segments.join(',')}:$${
            (this.chunk.org + this.chunk.data.length).toString(16)}`;
  }

  resolve(expr: Expr): Expr {
    const out = Exprs.traverse(expr, (e, rec) => {
      while (e.op === 'sym' && e.sym) {
        e = this.resolveSymbol(e);
      }
      return Exprs.evaluate(rec(e));
    });
    if (this.opts.refExtractor?.ref && out !== expr) {
      const orig = this.exprMap.get(expr) || expr;
      this.exprMap.set(out, orig);
    }
    return out;
  }

  resolveSymbol(symbol: Expr): Expr {
    const name = symbol.sym!;
    const parsed = parseSymbol(name);
    if (parsed.type === 'pc') {
      return this.pc();
    } else if (parsed.type === 'anon' && parsed.num > 0) {
      // anonymous forward ref
      const i = parsed.num - 1;
      let num = this.anonymousForward[i];
      if (num != null) return {op: 'sym', num};
      this.anonymousForward[i] = num = this.symbols.length;
      this.symbols.push({id: num});
      return {op: 'sym', num};
    } else if (parsed.type === 'rts' && parsed.num > 0) {
      // rts forward ref
      const i = parsed.num - 1;
      let num = this.rtsRefsForward[i];
      if (num != null) return {op: 'sym', num};
      this.rtsRefsForward[i] = num = this.symbols.length;
      this.symbols.push({id: num});
      return {op: 'sym', num};
    } else if (parsed.type === 'rel' && parsed.num > 0) {
      // relative forward ref
      let num = this.relativeForward[parsed.num - 1];
      if (num != null) return {op: 'sym', num};
      this.relativeForward[name.length - 1] = num = this.symbols.length;
      this.symbols.push({id: num});
      return {op: 'sym', num};
    } else if (parsed.type === 'anon' && parsed.num < 0) {
      // anonymous back ref
      const i = this.anonymousReverse.length + parsed.num;
      if (i < 0) this.fail(`Bad anonymous backref: ${name}`);
      return this.anonymousReverse[i];
    } else if (parsed.type === 'rts' && parsed.num < 0) {
      // rts back ref
      const i = this.rtsRefsReverse.length + parsed.num;
      if (i < 0) this.fail(`Bad rts backref: ${name}`);
      return this.rtsRefsReverse[i];
    } else if (parsed.type === 'rel' && parsed.num < 0) {
      // relative back ref
      const expr = this.relativeReverse[name.length - 1];
      if (expr == null) this.fail(`Bad relative backref: ${name}`);
      return expr;
    }
    const scope = name.startsWith('@') ? this.cheapLocals : this.currentScope;
    const sym = scope.resolve(name, {allowForwardRef: true, ref: symbol});
    if (sym.expr) {
      // console.log(`sometging: ${JSON.stringify(sym)}`);
      return sym.expr;
    }
    // if the expression is not yet known then refer to the symbol table,
    // adding it if necessary.
    if (sym.id == null) {
      sym.id = this.symbols.length;
      this.symbols.push(sym);
    }

    // console.log(`resolve 1: ${JSON.stringify(sym)}`);
    return {op: 'sym', num: sym.id};
  }

  // No banks are resolved yet.
  chunkData(chunk: number): {org?: number} {
    // TODO - handle zp segments?
    return {org: this.chunks[chunk].org};
  }

  closeScopes() {
    this.cheapLocals.clear();
    const collector = this.errorCollector;

    // Need to find any undeclared symbols in nested scopes and link
    // them to a parent scope symbol if possible.
    const close = (scope: Scope) => {
      for (const child of scope.children.values()) {
        close(child);
      }
      for (const child of scope.anonymousChildren) {
        close(child);
      }
      for (const [name, sym] of scope.symbols) {
        if (sym.expr || sym.id == null) continue;
        if (scope.parent) {
          // TODO - record where it was referenced?
          if (sym.scoped) {
            collector.add('error', `Symbol '${name}' undefined`, sym.ref?.source);
            continue;
          }
          const parentSym = scope.parent.symbols.get(name);
          if (!parentSym) {
            // just alias it directly in the parent scope
            scope.parent.symbols.set(name, sym);
          } else if (parentSym.id != null && parentSym.id >= 0) {
            // If this is resolving a macro from a parent symbol, try to use that value, otherwise
            // fall back to parent sym id
            sym.expr = {op: 'sym', num: parentSym.id};
          } else if (parentSym.expr) {
            sym.expr = parentSym.expr;
          } else {
            // must have either id or expr...?
            collector.add('error', `Internal error: symbol '${name}' has neither id nor expr`, sym.ref?.source);
          }
        }
        // handle global scope separately...
      }
    };

    // test case: ref a name in two child scopes, define it in grandparent

    if (this.currentScope.parent) {
      // TODO - record where it was opened?
      collector.add('error', `Scope never closed`);
    }
    close(this.currentScope);

    for (const [name, global] of this.globals) {
      // Resolve the symbol in the scope the declaration appeared in and
      // fall back to the global scope if not found.
      const scope = this.globalScopes.get(name) ?? this.currentScope;
      const sym = scope.symbols.get(name);
      // `.global` is import-or-export depending on whether it got defined here.
      const kind = global === 'global' ? (sym?.expr ? 'export' : 'import') : global;
      if (kind === 'export') {
        if (!sym?.expr) {
          collector.add('error', `Exported symbol '${name}' undefined`, sym?.ref?.source);
          continue;
        }
        if (sym.id == null) {
          sym.id = this.symbols.length;
          this.symbols.push(sym);
        }
        sym.export = name;
      } else if (kind === 'import') {
        if (!sym) continue; // okay to import but not use.
        // TODO - record both positions?
        if (sym.expr) {
          collector.add('error', `Symbol '${name}' already defined`, sym.ref?.source);
          continue;
        }
        // Zeropage imports carry a one-byte size so references pick zp modes.
        const expr: Expr = {op: 'im', sym: name};
        if (this.zeropageGlobals.has(name)) expr.meta = {size: 1};
        sym.expr = expr;
      } else {
        assertNever(kind);
      }
    }

    for (const [name, sym] of this.currentScope.symbols) {
      if (!sym.expr) {
        collector.add('error', `Symbol '${name}' undefined`, sym.ref?.source);
      }
    }
  }

  module(): Module {
    this.closeScopes();

    // TODO - handle imports and exports out of the scope
    // TODO - add .scope and .endscope and forward scope vars at end to parent

    // Process and write the data
    const chunks: mod.Chunk[] = [];
    for (const chunk of this.chunks) {
      chunks.push({...chunk, data: Uint8Array.from(chunk.data)});
    }
    const symbols: mod.Symbol[] = [];
    for (const symbol of this.symbols) {
      if (symbol.expr == null) {
        // Symbol was referenced but never defined - already recorded in closeScopes
        // Skip it to allow module generation to continue
        continue;
      }
      const out: mod.Symbol = {expr: symbol.expr};
      if (symbol.export != null) out.export = symbol.export;
      symbols.push(out);
    }
    const segments: mod.Segment[] = [...this.segmentData.values()];

    // Collect all symbols from all scopes for debug purposes
    let debugSymbols: mod.Symbol[] | undefined = undefined;
    if (this.opts.generateDebugInfo) {
      debugSymbols = [];
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

            debugSymbols!.push({expr});
          }
        }
        for (const child of scope.children.values()) {
          collectSymbols(child);
        }
        for (const child of scope.anonymousChildren) {
          collectSymbols(child);
        }
      };
      collectSymbols(this.currentScope.global);

      // Add cheap local and anonymous labels from debugLabels array
      for (const {name, expr: originalExpr} of this.debugLabels) {
        const expr = {...originalExpr};
        // All entries in debugLabels start with @ (temp labels like @loop, anonymous like @p/@m)
        const baseName = name.substring(1).replace(':', ''); // Remove @ prefix and any colons
        expr.sym = makeUniqueName(baseName);
        debugSymbols.push({expr});
      }
    }

    return {chunks, symbols, segments, debugSymbols};
  }

  // Assemble from a list of tokens
  async line(tokens: Token[]) {
    if (Tokens.eq(tokens[1], Tokens.ASSIGN) || Tokens.eq(tokens[1], Tokens.SET)) {
      // Skip over any assignments as these were handled in the preprocessor?
      // TODO: Should the preprocessor remove the tokens?
      return;
    }
    this._source = tokens[0].source;

    try {
      // Inside a .struct/.enum, a leading identifier is a member declaration and not
      // an instruction. We still need to watch for `.endstruct` and similar instructions though.
      if (this.structContext.length && tokens[0].token === 'ident') {
        this.structMember(tokens);
      } else if (tokens.length < 3 && Tokens.eq(tokens[tokens.length - 1], Tokens.COLON)) {
        this.label(tokens[0]);
      } else if (tokens[0].token === 'cs') {
        this.directive(tokens);
      } else {
        await this.instruction(tokens);
      }
    } catch (err) {
      if (err instanceof RecoverableError) {
        // Error already recorded, continue to next line
        return;
      }
      // Re-throw unrecoverable errors, and use this line for the source if
      // it didn't have a source attached in the err.
      throw Tokens.SourceError.locate(err, this._source);
    }
  }

  // Assemble from a token source. The optional signal is polled once per line so a long
  // assembly can be cancelled cooperatively; an aborted signal throws, which the caller
  // (compile) turns into an ordinary failure result.
  async tokens(source: Tokens.Source, signal?: { readonly aborted: boolean }) {
    let line;
    while ((line = await source.next())) {
      if (signal?.aborted) throw new Error('Compilation cancelled');
      await this.line(line);
    }
  }

  // Assemble from an async token source
  // async tokensAsync(source: Tokens.Async): Promise<void> {
  //   let line;
  //   while ((line = await source.nextAsync())) {
  //     this.line(line);
  //   }
  // }

  directive(tokens: Token[]) {
    // TODO - record line information, rewrap error messages?
    this.errorToken = tokens[0];
    try {
      switch (Tokens.str(tokens[0])) {
        case '.org': return this.org(this.parseConst(tokens, 1));
        case '.reloc': return this.parseNoArgs(tokens, 1), this.reloc();
        case '.assert': return this.assert(...this.parseAssert(tokens));
        case '.segment': return this.segment(...this.parseSegmentList(tokens, 1, false));
        case '.byte': return this.byte(...this.parseDataList(tokens, true));
        case '.bytestr': return this.byteInternal(this.parseByteStr(tokens));
        case '.res': return this.res(...this.parseResArgs(tokens));
        case '.word': return this.word(...this.parseDataList(tokens));
        case '.free': return this.free(this.parseConst(tokens, 1));
        case '.segmentprefix': return this.segmentPrefix(this.parseStr(tokens, 1));
        case '.import': return this.import(...this.parseIdentifierList(tokens));
        case '.export': return this.export(...this.parseIdentifierList(tokens));
        case '.importzp': return this.importzp(...this.parseIdentifierList(tokens));
        case '.exportzp': return this.exportzp(...this.parseIdentifierList(tokens));
        case '.global': return this.global(...this.parseIdentifierList(tokens));
        case '.globalzp': return this.globalzp(...this.parseIdentifierList(tokens));
        case '.charmap': return this.charmap(tokens);
        case '.strmap': return this.strmap(tokens);
        case '.pushcharmap': return this.parseNoArgs(tokens, 1),
          void this.charmapStack.push(new Map(this.charMapping));
        case '.popcharmap': return this.parseNoArgs(tokens, 1),
          void (this.charMapping = this.charmapStack.pop() ?? this.charMapping);
        case '.asciiz': return this.asciiz(...this.parseDataList(tokens, true));
        case '.align': return this.alignDir(tokens);
        case '.struct': return this.beginStruct(tokens, 'struct');
        case '.union': return this.beginStruct(tokens, 'struct'); // union sized like struct here
        case '.enum': return this.beginStruct(tokens, 'enum');
        case '.endstruct': return this.parseNoArgs(tokens, 1), this.endStruct('struct');
        case '.endunion': return this.parseNoArgs(tokens, 1), this.endStruct('struct');
        case '.endenum': return this.parseNoArgs(tokens, 1), this.endStruct('enum');
        case '.scope': return this.scope(this.parseOptionalIdentifier(tokens));
        case '.endscope': return this.parseNoArgs(tokens, 1), this.endScope();
        case '.proc': return this.proc(this.parseRequiredIdentifier(tokens));
        case '.endproc': return this.parseNoArgs(tokens, 1), this.endProc();
        case '.pushseg': return this.pushSeg(...this.parseSegmentList(tokens, 1, true));
        case '.popseg': return this.parseNoArgs(tokens, 1), this.popSeg();
        case '.move': return this.move(...this.parseMoveArgs(tokens));
        case '.out': return this.log('info', tokens);
        case '.warning': return this.log('warn', tokens);
        case '.error': return this.log('error', tokens);

        case '.a8':
        case '.i8':
        case '.p02':
          // NOTE: Will need to be actually implemented if 16-bit CPU support is added.
          return;

        // Segment shorthands: ca65 predeclares these named segments.
        case '.zeropage': return this.parseNoArgs(tokens, 1), this.segment('ZEROPAGE');
        case '.code': return this.parseNoArgs(tokens, 1), this.segment('CODE');
        case '.data': return this.parseNoArgs(tokens, 1), this.segment('DATA');
        case '.rodata': return this.parseNoArgs(tokens, 1), this.segment('RODATA');
        case '.bss': return this.parseNoArgs(tokens, 1), this.segment('BSS');

        // Unused directives we can figure out what to do with later.
        case '.setcpu':
        case '.feature':
        case '.autoimport':
        case '.case':
        case '.listbytes':
        case '.pagelength':
        case '.fileopt':
        case '.localchar':
        case '.linecont':
        case '.debuginfo':
        case '.condes':
        case '.constructor':
        case '.destructor':
        case '.interruptor':
          return;
      }
      this.fail(`Unknown directive: ${Tokens.nameOf(tokens[0])}`, tokens[0]);
    } finally {
      this.errorToken = undefined;
    }
  }

  label(label: string|Token) {
    let ident: string;
    let token: Token|undefined;
    const expr = this.pc();
    if (typeof label === 'string') {
      ident = label;
    } else {
      ident = Tokens.str(token = label);
      if (label.source) expr.source = label.source;
    }
    if (ident === ':') {
      // anonymous label - shift any forward refs off, and push onto the backs.
      this.anonymousReverse.push(expr);
      const sym = this.anonymousForward.shift();
      if (sym != null) this.symbols[sym].expr = expr;
      if (this.opts.generateDebugInfo) {
        this.debugLabels.push({name: '@p', expr});
      }
      return;
    } else if (/^\++$/.test(ident)) {
      // relative forward ref - fill in global symbol we made earlier
      const sym = this.relativeForward[ident.length - 1];
      delete this.relativeForward[ident.length - 1];
      if (sym != null) this.symbols[sym].expr = expr;
      if (this.opts.generateDebugInfo) {
        this.debugLabels.push({name: '@p', expr});
      }
      return;
    } else if (/^-+$/.test(ident)) {
      // relative backref - store the expr for later
      this.relativeReverse[ident.length - 1] = expr;
      if (this.opts.generateDebugInfo) {
        this.debugLabels.push({name: '@m', expr});
      }
      return;
    }

    if (!ident.startsWith('@')) {
      this.cheapLocals.clear();
      if (!this.chunk.name && !this.chunk.data.length) this.chunk.name = ident;
      if (this.opts.refExtractor?.label && this.chunk.org != null) {
        this.opts.refExtractor.label(
            ident, this.chunk.org + this.chunk.data.length, this.chunk.segments);
      }
      // Add label to debug info
      if (this.opts.generateDebugInfo && this._chunk?.labelIndex) {
        this._chunk.labelIndex.set(ident, this.chunk.data.length);
      }
    }
    this.assignSymbol(ident, false, expr, token);
    // const symbol = this.scope.resolve(str, true);
    // if (symbol.expr) throw new Error(`Already defined: ${label}`);
    // if (!this.chunk) throw new Error(`Impossible?`);
    // const chunkId = this.chunks.length - 1; // must be AFTER this.chunk
    // symbol.expr = {op: 'off', num: this.offset, chunk: chunkId};
    // if (source) symbol.expr.source = source;
    // // Add the label to the current chunk...?
    // // Record the definition, etc...?
  }

  assignSym(tokens: Token[]) {
    // Set source location for debug info before processing the assignment
    if (this.opts.generateDebugInfo && tokens[0].source) {
      this._source = tokens[0].source;
    }
    this.assign(Tokens.str(tokens[0]), this.parseExpr(tokens, 2));
  }

  setSym(tokens: Token[]) {
    // Set source location for debug info before processing the assignment
    if (this.opts.generateDebugInfo && tokens[0].source) {
      this._source = tokens[0].source;
    }
    this.set(Tokens.str(tokens[0]), this.parseExpr(tokens, 2));
  }

  assign(ident: string, expr: Expr|number) {
    if (ident.startsWith('@')) {
      this.fail(`Cheap locals may only be labels: ${ident}`);
    }
    // Now make the assignment.
    if (typeof expr !== 'number') expr = this.resolve(expr);
    this.assignSymbol(ident, false, expr);
    // TODO - no longer needed?
    if (this.opts.refExtractor?.assign && typeof expr === 'number') {
      this.opts.refExtractor.assign(ident, expr);
    }
  }

  set(ident: string, expr: Expr|number) {
    if (ident.startsWith('@')) {
      this.fail(`Cheap locals may only be labels: ${ident}`);
    }
    // Now make the assignment.
    if (typeof expr !== 'number') expr = this.resolve(expr);
    this.assignSymbol(ident, true, expr);
  }

  assignSymbol(ident: string, mut: boolean, expr: Expr|number, token?: Token) {
    // NOTE: * _will_ get current chunk!

    if (typeof expr === 'number') expr = {op: 'num', num: expr, meta: Exprs.size(expr)};

    // Store symbol name and source info in expression for debug info
    if (this.opts.generateDebugInfo && this._source && !expr.source) {
      expr.source = this._source;
    }

    const isCheapLocal = ident.startsWith('@');
    const scope = isCheapLocal ? this.cheapLocals : this.currentScope;
    // NOTE: This is incorrect - it will look up the scope chain when it
    // shouldn't.  Mutables may or may not want this, immutables must not.
    // Whether this is tied to allowFwdRef or not is unclear.  It's also
    // unclear whether we want to allow defining symbols in outside scopes:
    //   ::foo = 43
    // FWIW, ca65 _does_ allow this, as well as foo::bar = 42 after the scope.
    let sym = scope.resolve(ident, {allowForwardRef: !mut, ref: token});
    if (sym && (mut !== (sym.id! < 0))) {
      this.fail(`Cannot change mutability of ${ident}`, token);
    } else if (mut && expr.op != 'num') {
      this.fail(`Mutable set requires constant`, token);
    } else if (!sym) {
      if (!mut) throw new Error(`impossible`);
      scope.symbols.set(ident, sym = {id: -1});
    } else if (!mut && sym.expr) {
      const orig =
          sym.expr.source ? `\nOriginally defined${Tokens.at(sym.expr)}` : '';
      this.fail(`Redefining symbol ${ident}${orig}`, token);
    }
    sym.expr = expr;

    // Add cheap locals to debugLabels for MLB output
    if (isCheapLocal && !mut && this.opts.generateDebugInfo) {
      this.debugLabels.push({name: ident, expr});
    }
  }

  async instruction(mnemonic: string, arg?: Arg|string): Promise<void>;
  async instruction(tokens: Token[]): Promise<void>;
  async instruction(...args: [Token[]]|[string, (Arg|string)?]): Promise<void> {
    let mnemonic: string;
    let arg: Arg;
    if (args.length === 1 && Array.isArray(args[0])) {
      // handle the line...
      const tokens = args[0];
      mnemonic = Tokens.expectIdentifier(tokens[0]).toLowerCase();
      arg = this.parseArg(tokens, 1);
    } else if (typeof args[1] === 'string') {
      // parse the tokens first
      mnemonic = args[0] as string;
      const tokenizer = new Tokenizer(args[1]);
      arg = this.parseArg((await tokenizer.next())!, 0);
    } else {
      [mnemonic, arg] = args as [string, Arg];
      if (!arg) arg = ['imp'];
      mnemonic = mnemonic.toLowerCase();
    }
    if (mnemonic === 'rts') {
      // NOTE: we special-case this in both the tokenizer and here so that
      // `rts:+` and `rts:-` work for pointing to an rts instruction.
      const expr = this.pc();
      this.rtsRefsReverse.push(expr);
      const sym = this.rtsRefsForward.shift();
      if (sym != null) this.symbols[sym].expr = expr;
    }
    // may need to size the arg, depending.
    // cpu will take 'add', 'a,x', and 'a,y' and indicate which it actually is.
    const ops = this.cpu.op(mnemonic); // will throw if mnemonic unknown
    const m = arg[0];
    if (m === 'add' || m === 'a,x' || m === 'a,y') {
      // Special case for address mnemonics
      let expr = arg[1]!;
      // Attempt to resolve the expression first. If we are able to, then
      // we can appropriately size the expression

      // console.log(`before resolving: ${JSON.stringify(expr)}`);
      // expr = this.resolve(expr);
      
      // If the size is unknown, but it was declared zp through
      // importzp/globalzp then we force it to 1 byte.
      const s = expr.meta?.size ?? (this.isZeropageRef(expr) ? 1 : 2);
      // console.log(`sizing up 'add' expr: ${JSON.stringify(expr)}`);
      if (m === 'add' && s === 1 && 'zpg' in ops) {
        return this.opcode(ops.zpg!, 1, expr);
      } else if (m === 'add' && 'abs' in ops) {
        return this.opcode(ops.abs!, 2, expr);
      } else if (m === 'add' && 'rel' in ops) {
        return this.relative(ops.rel!, 1, expr);
      } else if (m === 'a,x' && s === 1 && 'zpx' in ops) {
        return this.opcode(ops.zpx!, 1, expr);
      } else if (m === 'a,x' && 'abx' in ops) {
        return this.opcode(ops.abx!, 2, expr);
      } else if (m === 'a,y' && s === 1 && 'zpy' in ops) {
        return this.opcode(ops.zpy!, 1, expr);
      } else if (m === 'a,y' && 'aby' in ops) {
        return this.opcode(ops.aby!, 2, expr);
      }
      this.fail(`Bad address mode ${m} for ${mnemonic}`);
    }
    // All other mnemonics
    if (m in ops) {
      const argLen = this.cpu.argLen(m);
      if (m === 'rel') return this.relative(ops[m]!, argLen, arg[1]!);
      return this.opcode(ops[m]!, argLen, arg[1]!);
    }
    this.fail(`Bad address mode ${m} for ${mnemonic}`);
  }

  parseArg(tokens: Token[], start: number): Arg {
    // Look for parens/brackets and/or a comma
    if (tokens.length === start) return ['imp'];
    const front = tokens[start];
    const next = tokens[start + 1];
    if (tokens.length === start + 1) {
      if (Tokens.isRegister(front, 'a')) return ['acc'];
    } else if (Tokens.eq(front, Tokens.IMMEDIATE)) {
      return ['imm', this.parseExpr(tokens, start + 1)];
    }
    // Look for relative or anonymous labels, which are not valid on their own
    if (Tokens.eq(front, Tokens.COLON) && tokens.length === start + 2 &&
        next.token === 'op' && /^[-+]+$/.test(next.str)) {
      // anonymous label
      return ['add', {op: 'sym', sym: ':' + next.str}];
    } else if (tokens.length === start + 1 && front.token === 'op' &&
               /^[-+]+$/.test(front.str)) {
      // relative label
      return ['add', {op: 'sym', sym: front.str}];
    }
    // check to see if there is a zp,abs,far operator forcing a new addressing mode type
    if (front.token == 'ident' && (front.str == 'a' || front.str == 'z') && Tokens.eq(next, Tokens.COLON)) {
      // Get the rest of the expression and force the addressing mode to the required one
      const [mode, out] = this.parseArg(tokens, start + 2);
      if (mode == 'acc' || mode == 'imm') {
        this.fail(`Cannot force direct or absolute addressing on acc or imm arguments`, front);
      }
      const lookup = (front.str == 'z') ? ForceDirectAddressingMap : ForceAbsoluteAddressingMap;
      const adr = lookup.get(mode);
      return [adr ? adr! : mode as ArgMode, out!];
    }
    // it must be an address of some sort - is it indirect?
    if (Tokens.eq(front, Tokens.LP) ||
        (this.opts.allowBrackets && Tokens.eq(front, Tokens.LB))) {
      const close = Tokens.findBalanced(tokens, start);
      if (close < 0) this.fail(`Unbalanced ${Tokens.name(front)}`, front);
      const args = Tokens.parseArgList(tokens, start + 1, close);
      if (!args.length) this.fail(`Bad argument`, front);
      const expr = this.parseExpr(args[0], 0);
      if (args.length === 1) {
        // either IND or INY
        if (Tokens.eq(tokens[close + 1], Tokens.COMMA) &&
            Tokens.isRegister(tokens[close + 2], 'y')) {
          Tokens.expectEol(tokens[close + 3]);
          return ['iny', expr];
        }
        Tokens.expectEol(tokens[close + 1]);
        return ['ind', expr];
      } else if (args.length === 2 && args[1].length === 1) {
        // INX
        if (Tokens.isRegister(args[1][0], 'x')) return ['inx', expr];
      }
      this.fail(`Bad argument`, front);
    }
    const args = Tokens.parseArgList(tokens, start);
    if (!args.length) this.fail(`Bad arg`, front);
    const expr = this.parseExpr(args[0], 0);
    if (args.length === 1) return ['add', expr];
    if (args.length === 2 && args[1].length === 1) {
      if (Tokens.isRegister(args[1][0], 'x')) return ['a,x', expr];
      if (Tokens.isRegister(args[1][0], 'y')) return ['a,y', expr];
    }
    this.fail(`Bad arg`, front);
  }

  relative(op: number, arglen: number, expr: Expr) {
    // Can arglen ever be 2? (yes - brl on 65816)
    // Basic plan here is that we actually want a relative expr.
    // TODO - clean this up to be more efficient.
    // TODO - handle local/anonymous labels separately?
    const num = this.chunk.data.length + arglen + 1;
    const meta: Exprs.Meta = {rel: true, chunk: this.chunks.length - 1};
    if (this._chunk?.org) meta.org = this._chunk.org;
    const nextPc = {op: 'num', num, meta};
    // Mark the subtraction as a branch for signed range checking
    const rel: Expr = {op: '-', args: [expr, nextPc], meta: {branch: true}};
    if (expr.source) rel.source = expr.source;
    this.opcode(op, arglen, rel);
  }

  opcode(op: number, arglen: number, expr: Expr) {
    // Emit some bytes.
    if (arglen) expr = this.resolve(expr); // BEFORE opcode (in case of *)
    const {chunk} = this;
    this.markWritten(1 + arglen);

    // Record source info for this instruction
    if (this.opts.generateDebugInfo && this._chunk?.sourceMap && this._source) {
      this._chunk.sourceMap.set(chunk.data.length, this._source);
    }

    chunk.data.push(op);
    if (arglen) {
      this.append(expr, arglen);
    }
    if (!chunk.name) chunk.name = `Code`;
    // TODO - for relative, if we're in the same chunk, just compare
    // the offset...
  }

  private markWritten(size: number) {
    if (this._chunk?.org == null) return;
    // NOTE: it's possible the chunk has spilled over into the next segment.
    // We just ignore this by asking for the offset of the _start_ of the
    // chunk, rather than the current position.  This is consistent with how
    // the linker works, but can lead to issues with free'd parts, etc.
    // Fortunately, the risk is relatively small because it's only relevant
    // for statically-placed chunks, and (one would hope) we know what we're
    // doing there.
    const offset = this.orgToOffset(this._chunk.org);
    if (offset != null) {
      this.written.add(offset + this._chunk.data.length,
                       offset + this._chunk.data.length + size);
    }
  }

  append(expr: Expr, size: number) {
    const {chunk} = this;
    // Save the ref, as long as it's actually interesting.
    if (this.opts.refExtractor?.ref && chunk.org != null) {
      const orig = this._exprMap?.get(expr) || expr;
      if (Exprs.symbols(orig).length > 0) {
        this.opts.refExtractor.ref(orig, size,
                                      chunk.org + chunk.data.length,
                                      chunk.segments);
      }
    }
    // Append the number or placeholder
    expr = this.resolve(expr);
    const val = expr.num!;
    if (expr.op !== 'num' || expr.meta?.rel) {
      // use a placeholder and add a substitution
      const offset = chunk.data.length;
      (chunk.subs || (chunk.subs = [])).push({offset, size, expr});
      this.writeNumber(chunk.data, size); // write goes after subs
    } else {
      this.writeNumber(chunk.data, size, val);
    }
  }

  ////////////////////////////////////////////////////////////////
  // Directive handlers

  org(addr: number, name?: string) {
    if (this._org != null && this._chunk != null &&
      this._org + this._chunk.data.length === addr) {
      return; // nothing to do?
    }
    this._org = addr;
    this._chunk = undefined;
    this._name = name;
  }

  reloc(name?: string) {
    this._org = undefined;
    this._chunk = undefined;
    this._name = name;
  }

  segment(...segments: Array<string|mod.Segment>) {
    // Usage: .segment "1a", "1b", ...
    this.segments = segments.map(s => typeof s === 'string' ? s : s.name);
    for (const s of segments) {
      if (typeof s === 'object') {
        const data = this.segmentData.get(s.name) || {name: s.name};
        this.segmentData.set(s.name, mod.Segment.merge(data, s));
      }
    }
    this._chunk = undefined;
    this._name = undefined;
  }

  assert(expr: Expr, _level?: string, message?: string) {
    expr = this.resolve(expr);
    const val = this.evaluate(expr);
    if (val != null) {
      if (!val) {
        let pc = '';
        const chunk = this.chunk;
        if (chunk.org != null) {
          pc = ` (PC=$${(chunk.org + chunk.data.length).toString(16)})`;
        }
        this.fail(`${message}\nAssertion failed${pc}`, expr);
      }
    } else {
      const {chunk} = this;
      (chunk.asserts || (chunk.asserts = [])).push(expr);
    }
  }

  byte(...args: Array<Expr|string|number>) {
    this.byteInternal(args);
  }

  // `.asciiz` emits the bytes then a terminating NUL
  // .charmap/.strmap applies to the string bytes but not the terminator character.
  asciiz(...args: Array<Expr|string|number>) {
    this.byteInternal([...args, 0]);
  }

  beginStruct(tokens: Token[], kind: 'struct'|'enum') {
    const name = this.parseOptionalIdentifier(tokens);
    if (name != null) this.enterScope(name, 'scope');
    this.structContext.push({kind, offset: 0, name: name ?? undefined});
  }

  endStruct(kind: 'struct'|'enum') {
    const ctx = this.structContext.pop();
    if (!ctx || ctx.kind !== kind) this.fail(`.end${kind} without a matching .${kind}`);
    if (ctx!.name != null) {
      this.exitScope('scope');
      // Assign a symbol to hold the size of the struct so `.sizeof(StructName)` works
      this.assign(ctx!.name, ctx!.offset);
    }
  }

  structMember(tokens: Token[]) {
    const ctx = this.structContext[this.structContext.length - 1];
    const name = Tokens.str(tokens[0]);
    this.assign(name, ctx.offset);
    if (ctx.kind === 'enum') {
      ctx.offset += 1;
    } else {
      ctx.offset += this.structMemberSize(tokens);
    }
  }

  // Parses out the rest of a struct member to figure out the size of it
  private structMemberSize(tokens: Token[]): number {
    const typeTok = tokens[1];
    if (!typeTok || typeTok.token !== 'cs') {
      this.fail(`struct member '${Tokens.str(tokens[0])}' needs a storage type`, tokens[0]);
    }
    const t = Tokens.str(typeTok);
    if (t === '.tag') {
      const structName = Tokens.expectIdentifier(tokens[2]);
      const sz = this.evaluate(this.symbol(structName));
      if (sz == null) this.fail(`.tag references unknown struct: ${structName}`, tokens[2]);
      return sz;
    }
    let unit: number;
    switch (t) {
      // NOTE: .addr is tokenized as .word, so it lands in the 2-byte case.
      case '.byte': case '.res': unit = 1; break;
      case '.word': case '.dbyt': unit = 2; break;
      case '.faraddr': unit = 3; break;
      case '.dword': unit = 4; break;
      default: this.fail(`Unsupported struct member type: ${t}`, typeTok);
    }
    // Optional element count (`field .byte 16`); required for .res.
    if (tokens.length > 2) return unit * this.parseConst(tokens, 2);
    if (t === '.res') this.fail(`.res in a struct needs a count`, typeTok);
    return unit;
  }

  alignDir(tokens: Token[]) {
    const args = Tokens.parseArgList(tokens, 1);
    if (args.length < 1 || args.length > 2) this.fail(`.align expects a boundary and optional fill`, tokens[0]);
    const boundary = this.parseConst(args[0], 0);
    const fill = args.length > 1 ? this.parseConst(args[1], 0) : undefined;
    this.align(boundary, fill);
  }

  align(boundary: number, fill?: number) {
    if (boundary < 1) this.fail(`.align boundary must be positive: ${boundary}`);
    // ca65 requires a power-of-two boundary unless the force option is supplied.
    // ... which we don't have yet. TODO
    if ((boundary & (boundary - 1)) !== 0) this.fail(`.align boundary must be a power of two: ${boundary}`);
    if (boundary === 1) return; // no-op
    if (this._org != null) {
      // We have an org address, so we are in absolute mode meaning we can
      // do the padding now too.
      const pc = (this._chunk?.org ?? this._org) + (this._chunk?.data.length ?? 0);
      const pad = (boundary - (pc % boundary)) % boundary;
      if (pad) this.res(pad, fill);
      return;
    }
    // Relocatable mode means we just delay this until link time instead
    this._chunk = undefined;
    this._pendingAlign = boundary;
    this._pendingFill = fill;
  }

  // CA65 compatible 1:1 character mapping. Given a single char byte or a byte literal,
  // converts it to the output value. This applies to any characters in any strings
  charmap(tokens: Token[]) {
    const args = Tokens.parseArgList(tokens, 1);
    if (args.length !== 2) this.fail(`.charmap expects an index and a value`, tokens[0]);
    const code = this.parseConst(args[0], 0);
    const target = this.parseConst(args[1], 0);
    if (code < 0 || code > 255) this.fail(`.charmap index out of range: ${code}`, tokens[0]);
    this.charMapping.set(String.fromCodePoint(code), [target & 0xff]);
  }

  // Our own custom string based mapping, which allows any N input bytes to M output bytes
  // This works by greedily consuming bytes and choosing the largest match first as our output.
  strmap(tokens: Token[]) {
    const keyTok = tokens[1];
    if (!keyTok || keyTok.token !== 'str') this.fail(`.strmap expects a string key`, tokens[0]);
    const key = keyTok.str;
    if (!key) this.fail(`.strmap key must not be empty`, keyTok);
    const commaIdx = Tokens.find(tokens, Tokens.COMMA, 2);
    if (commaIdx < 0) this.fail(`.strmap expects a value after the key`, tokens[0]);
    const valueToks = tokens.slice(commaIdx + 1);
    if (!valueToks.length) this.fail(`.strmap expects a value after the key`, tokens[tokens.length - 1]);
    let bytes: number[];
    // The syntax for a multi byte output with hardcoded numbers is `[ $00, $01, ... $mm ]`
    // so check for the bracket opening.
    if (Tokens.eq(valueToks[0], Tokens.LB)) {
      if (!Tokens.eq(valueToks[valueToks.length - 1], Tokens.RB)) {
        this.fail(`.strmap value list must end with ]`, valueToks[valueToks.length - 1]);
      }
      const inner = valueToks.slice(1, -1);
      bytes = inner.length ? Tokens.parseArgList(inner, 0).map(ts => this.parseConst(ts, 0)) : [];
      if (!bytes.length) this.fail(`.strmap value list must not be empty`, valueToks[0]);
    } else if (valueToks.length === 1 && valueToks[0].token === 'str' && !valueToks[0].char) {
      // If its a string, parse it using the current charmapping values (to match ca65 behavior)
      bytes = [];
      writeString(bytes, valueToks[0].str, this.charMapping);
      if (!bytes.length) this.fail(`.strmap value must not be empty`, valueToks[0]);
    } else {
      // Otherwise, its probaly some constant value or something.
      bytes = [this.parseConst(valueToks, 0)];
    }
    this.charMapping.set(key, bytes.map(b => b & 0xff));
  }

  byteInternal(args: Array<Expr|string|number>) {
    const {chunk} = this;
    this.markWritten(args.length);

    for (const arg of args) {
      // TODO - if we ran off the end of the segment, make a new chunk???
      // For now, we're avoiding needing to worry about it because orgToOffset
      // and markWritten are based on the start of the chunk, rather than where
      // it ends; but this is still a potential source of bugs!
      if (typeof arg === 'number') {
        // Record source info for each byte
        if (this.opts.generateDebugInfo && this._chunk?.sourceMap && this._source) {
          this._chunk.sourceMap.set(chunk.data.length, this._source);
        }
        this.writeNumber(chunk.data, 1, arg);
      } else if (typeof arg === 'string') {
        // Record source info for each character in the string
        if (this.opts.generateDebugInfo && this._chunk?.sourceMap && this._source) {
          for (let i = 0; i < arg.length; i++) {
            this._chunk.sourceMap.set(chunk.data.length + i, this._source);
          }
        }
        writeString(chunk.data, arg, this.charMapping);
      } else {
        // Record source info before append (which writes 1 byte)
        if (this.opts.generateDebugInfo && this._chunk?.sourceMap && this._source) {
          this._chunk.sourceMap.set(chunk.data.length, this._source);
        }
        this.append(arg, 1);
      }
    }
  }

  res(count: number, value?: number) {
    if (!count) return;
    this.byte(...new Array(count).fill(value ?? 0));
  }

  word(...args: Array<Expr|number>) {
    const {chunk} = this;
    this.markWritten(2 * args.length);

    for (const arg of args) {
      // Record source info for each byte of the word (2 bytes)
      if (this.opts.generateDebugInfo && this._chunk?.sourceMap && this._source) {
        this._chunk.sourceMap.set(chunk.data.length, this._source);
        this._chunk.sourceMap.set(chunk.data.length + 1, this._source);
      }
      if (typeof arg === 'number') {
        this.writeNumber(chunk.data, 2, arg);
      } else {
        this.append(arg, 2);
      }
    }
  }

  free(size: number) {
    // Must be in .org for a single segment.
    if (this._org == null) this.fail(`.free in .reloc mode`);
    this.markWritten(size);
    const segments = this.segments.length > 1 ? this.segments.filter(s => {
      const data = this.segmentData.get(s);
      if (!data || data.memory == null || data.size == null) return false;
      if (data.memory > this._org!) return false;
      if (data.memory + data.size <= this._org!) return false;
      return true;
    }) : this.segments;
    if (segments.length !== 1) {
      this.fail(`.free with non-unique segment: ${this.segments}`);
    } else if (size < 0) {
      this.fail(`.free with negative size: ${size}`);
    }
    // If we've got an open chunk, end it.
    if (this._chunk) {
      this._org += this._chunk.data.length;
    }
    this._chunk = undefined;
    // Ensure a segment object exists.
    const name = segments[0];
    let s = this.segmentData.get(name);
    if (!s) this.segmentData.set(name, s = {name});
    (s.free || (s.free = [])).push([this._org, this._org + size]);
    // Advance past the free space.
    this._org += size;
  }

  segmentPrefix(prefix: string) {
    // TODO - make more of a todo about changing this?
    this._segmentPrefix = prefix;
  }

  /** Whether an operand is a bare reference to a symbol declared zeropage. */
  private isZeropageRef(expr: Expr): boolean {
    return expr.op === 'sym' && expr.sym != null && this.zeropageGlobals.has(expr.sym);
  }

  private declareGlobal(ident: string, kind: 'export'|'import'|'global', weak = false) {
    if (weak && this.globals.has(ident)) return;
    this.globals.set(ident, kind);
    this.globalScopes.set(ident, this.currentScope);
  }

  import(...idents: string[]) {
    for (const ident of idents) this.declareGlobal(ident, 'import');
  }

  export(...idents: string[]) {
    for (const ident of idents) this.declareGlobal(ident, 'export');
  }

  importzp(...idents: string[]) {
    for (const ident of idents) {
      this.declareGlobal(ident, 'import');
      this.zeropageGlobals.add(ident);
    }
  }

  exportzp(...idents: string[]) {
    for (const ident of idents) {
      this.declareGlobal(ident, 'export');
      this.zeropageGlobals.add(ident);
    }
  }

  global(...idents: string[]) {
    // Don't clobber an explicit import/export declaration.
    for (const ident of idents) this.declareGlobal(ident, 'global', true);
  }

  globalzp(...idents: string[]) {
    for (const ident of idents) {
      this.declareGlobal(ident, 'global', true);
      this.zeropageGlobals.add(ident);
    }
  }

  scope(name?: string) {
    this.enterScope(name, 'scope');
  }

  proc(name: string) {
    this.label(name);
    this.enterScope(name, 'proc');
  }

  enterScope(name: string|undefined, kind: 'scope'|'proc') {
    const existing = name ? this.currentScope.children.get(name) : undefined;
    if (existing) {
      if (this.opts.reentrantScopes) {
        this.currentScope = existing;
        return;
      }
      this.fail(`Cannot re-enter scope ${name}`);
    }
    const child = new Scope(this.currentScope, kind);
    if (name) {
      this.currentScope.children.set(name, child);
    } else {
      this.currentScope.anonymousChildren.push(child);
    }
    this.currentScope = child;
  }

  endScope() { this.exitScope('scope'); }
  endProc() { this.exitScope('proc'); }

  exitScope(kind: 'scope'|'proc') {
    if (this.currentScope.kind !== kind || !this.currentScope.parent) {
      this.fail(`.end${kind} without .${kind}`);
    }
    this.currentScope = this.currentScope.parent;
  }

  pushSeg(...segments: Array<string|mod.Segment>) {
    this.segmentStack.push([this.segments, this._chunk]);
    // If pushseg was called without any segments, just keep the current segment
    if (segments) {
      this.segment(...segments);
    }
  }

  popSeg() {
    if (!this.segmentStack.length) this.fail(`.popseg without .pushseg`);
    [this.segments, this._chunk] = this.segmentStack.pop()!;
    this._org = this._chunk?.org;
  }

  move(size: number, source: Expr) {
    this.append({op: '.move', args: [source], meta: {size}}, size);
  }

  log(level: 'info'|'warn'|'error', line: Token[]) {
    const str = Tokens.expectString(line[1], line[0]);
    Tokens.expectEol(line[2], 'a single string');
    const source = line[0].source;

    // Map 'warn' to 'warning' for ErrorLevel
    const errorLevel: ErrorLevel = level === 'warn' ? 'warning' : level;
    this.errorCollector.add(errorLevel, str, source);

    if (level === 'error') {
      // For .error directive, record and throw to stop processing this line
      throw new RecoverableError(str);
    }
  }

  // Utility methods for processing arguments

  parseConst(tokens: Token[], start: number): number {
    const val = this.evaluate(this.parseExpr(tokens, start));
    if (val != null) return val;
    this.fail(`Expression is not constant`, tokens[1]);
  }
  parseNoArgs(tokens: Token[], _start: number) {
    Tokens.expectEol(tokens[1]);
  }
  parseExpr(tokens: Token[], start: number): Expr {
    return Exprs.parseOnly(tokens, start, this.currentScope.symbols, this.encodeChar);
  }

  /**
   * Converts the character to the numerical value for the output.
   * This assumes that it is not multimapped to multiple output bytes to keep
   * ca65 compatibility.
   */
  readonly encodeChar = (char: string): number|undefined => {
    const bytes = this.charMapping.get(char);
    if (!bytes) return undefined;
    if (bytes.length !== 1) {
      this.fail(`Character literal '${char}' maps to ${bytes.length} bytes`);
    }
    return bytes[0];
  };
  // parseStringList(tokens: Token[], start = 1): string[] {
  //   return Tokens.parseArgList(tokens, 1).map(ts => {
  //     const str = Tokens.expectString(ts[0]);
  //     Tokens.expectEol(ts[1], "a single string");
  //     return str;
  //   });
  // }
  parseStr(tokens: Token[], start: number): string {
    const str = Tokens.expectString(tokens[start]);
    Tokens.expectEol(tokens[start + 1], "a single string");
    return str;
  }

  parseOptionalStr(tokens: Token[], start: number): string | undefined {
    const tok = tokens[start];
    if (!tok) return undefined;
    if (tok.token === 'str') return tok.str;
    return undefined;
  }

  parseSegmentList(tokens: Token[], start: number, allowEmptySegmentList: boolean): Array<string|mod.Segment> {
    if (tokens.length < start + 1) {
      if (allowEmptySegmentList) {
        return [];
      }
      this.fail(`Expected a segment list`, tokens[start - 1]);
    }
    return Tokens.parseArgList(tokens, 1).map(ts => {
      const str = this._segmentPrefix + Tokens.expectString(ts[0]);
      if (ts.length === 1) return str;
      if (!Tokens.eq(ts[1], Tokens.COLON)) {
        this.fail(`Expected comma or colon: ${Tokens.name(ts[1])}`, ts[1]);
      }
      const seg = {name: str} as mod.Segment;
      // TODO - parse expressions...
      const attrs = Tokens.parseAttrList(ts, 1); // : ident [...]
      for (const [key, val] of attrs) {
        switch (key) {
          case 'bank': seg.bank = this.parseConst(val, 0); break;
          case 'size': seg.size = this.parseConst(val, 0); break;
          case 'off': seg.offset = this.parseConst(val, 0); break;
          case 'mem': seg.memory = this.parseConst(val, 0); break;
          case 'fill': seg.fill = this.parseConst(val, 0); break;
          case 'out': seg.out = this.parseOptionalStr(val, 0) ?? '%O'; break;
          case 'overlay': seg.overlay = this.parseStr(val, 0); break;
          // TODO allow setting free space
          // case 'free': seg.free = this.parseConst(val, 0); break;
          case 'zp': case 'zeropage': seg.addressing = 1; break;
          default: this.fail(`Unknown segment attr: ${key}`);
        }
      }
      // Only auto-assign offset if segment has an output file specified
      // Segments without :out and without :off are RAM segments (no file output)
      if (seg.offset === undefined && seg.size !== undefined && seg.out !== undefined) {
        seg.offset = this._segmentOffset;
        this._segmentOffset += seg.size;
      }
      if (seg.fill !== undefined && seg.size !== undefined) {
        seg.free = [[seg.memory ?? 0, (seg.memory ?? 0) + seg.size]];
      }
      return seg;
    });
  }

  parseResArgs(tokens: Token[]): [number, number?] {
    const data = this.parseDataList(tokens);
    if (data.length > 2) this.fail(`Expected at most 2 args`, data[2]);
    if (!data.length) this.fail(`Expected at least 1 arg`);
    const count = this.evaluate(data[0]);
    if (count == null) this.fail(`Expected constant count`);
    const val = data[1] && this.evaluate(data[1]);
    if (data[1] && val == null) this.fail(`Expected constant value`);
    return [count, val];
  }

  parseDataList(tokens: Token[]): Array<Expr>;
  parseDataList(tokens: Token[], allowString: true): Array<Expr|string>;
  parseDataList(tokens: Token[], allowString = false): Array<Expr|string> {
    if (tokens.length < 2) {
      this.fail(`Expected a data list`, tokens[0]);
    }
    const out: Array<Expr|string> = [];
    for (const term of Tokens.parseArgList(tokens, 1)) {
      if (allowString && term.length === 1 && term[0].token === 'str') {
        out.push(term[0].str);
      } else if (term.length < 1) {
        this.fail(`Missing term`);
      } else {
        out.push(this.resolve(this.parseExpr(term, 0)));
      }
    }
    return out;
  }

  parseIdentifierList(tokens: Token[]): string[] {
    if (tokens.length < 2) {
      this.fail(`Expected identifier(s)`, tokens[0]);
    }
    const out: string[] = [];
    for (const term of Tokens.parseArgList(tokens, 1)) {
      if (term.length !== 1 || term[0].token !== 'ident') {
        this.fail(`Expected identifier: ${Tokens.name(term[0])}`, term[0]);
      }
      out.push(Tokens.str(term[0]));
    }
    return out;
  }

  parseOptionalIdentifier(tokens: Token[]): string|undefined {
    const tok = tokens[1];
    if (!tok) return undefined;
    const ident = Tokens.expectIdentifier(tok);
    Tokens.expectEol(tokens[2]);
    return ident;
  }

  parseRequiredIdentifier(tokens: Token[]): string {
    const ident = Tokens.expectIdentifier(tokens[1]);
    Tokens.expectEol(tokens[2]);
    return ident;
  }

  parseMoveArgs(tokens: Token[]): [number, Expr] {
    // .move 10, ident        ; must be an offset
    // .move 10, $1234, "seg" ; maybe support this?
    const args = Tokens.parseArgList(tokens, 1);
    if (args.length !== 2 /* && args.length !== 3 */) {
      this.fail(`Expected constant number, then identifier`);
    }
    const num = this.evaluate(this.parseExpr(args[0], 0));
    if (num == null) this.fail(`Expected a constant number`);

    // let segName = this.segments.length === 1 ? this.segments[0] : undefined;
    // if (args.length === 3) {
    //   if (args[2].length !== 1 || args[2][0].token !== 'str') {
    //     this.fail(`Expected a single segment name`, this.args[2][0]);
    //   }
    //   segName = args[2][0].str;
    // }
    // const seg = segName ? this.segmentData.get(segName) : undefined;

    const offset = this.resolve(this.parseExpr(args[1], 0));
    if (offset.op === 'num' && offset.meta?.chunk != null) {
      return [num, offset];
    } else {
      this.fail(`Expected a constant offset`, args[1][0]);
    }
  }

  parseByteStr(tokens: Token[]): Array<number> {
    const bytestr = Tokens.expectString(tokens[1]);
    Tokens.expectEol(tokens[2]);
    const buf = new Base64().decode(bytestr);
    return Array.from(new Uint8Array(buf));
  }

  parseAssert(tokens: Token[]) : [Expr, string, string] {
    const args = Tokens.parseArgList(tokens, 1);
    if (!args[0]) {
      this.fail(`No assertion expression provided`);
    }
    const expr = this.parseExpr(args[0], 0);
    const level = Tokens.optionalIdentifier(args.at(1)?.at(0)) ?? 'error';
    const message = Tokens.optionalString(args.at(2)?.at(0)) ?? "Assertion failed";
    
    return [expr, level, message]
  }

  // Diagnostics

  getMessages(): readonly AssemblerMessage[] {
    return this.errorCollector.getMessages();
  }

  hasErrors(): boolean {
    return this.errorCollector.hasErrors();
  }

  fail(msg: string, at?: {source?: Tokens.SourceInfo}): never {
    if (!at && this.errorToken) at = this.errorToken;
    const source = at?.source ?? this._source;

    // Record the error
    this.errorCollector.add('error', msg, source);

    // If we don't have any source info, then attach the chunk name to the
    // message to try and provide some context.
    const fullMsg = !source && !this._source && this._chunk?.name ?
        `${msg}\n  in ${this._chunk.name}` : msg;

    throw new RecoverableError(fullMsg, source);
  }

  writeNumber(data: number[], size: number, val?: number) {
    // TODO - if val is a signed/unsigned 32-bit number, it's not clear
    // whether we need to treat it one way or the other...?  but maybe
    // it doesn't matter since we're only looking at 32 bits anyway.

    // If the size doesn't match the incoming value, we silently truncate to the size
    // const s = (size) << 3;
    // if (val != null && (val < (-1 << s) || val >= (1 << s))) {
    //   const name = ['byte', 'word', 'farword', 'dword'][size - 1];
    //   this.fail(`Not a ${name}: $${val.toString(16)}`);
    // }
    for (let i = 0; i < size; i++) {
      data.push(val != null ? val & 0xff : 0xff);
      if (val != null) val >>= 8;
    }
  }

  orgToOffset(org: number): number|undefined {
    const segment = this.segmentData.get(
        this.segments.find(s => {
          const data = this.segmentData.get(s);
          return data && mod.Segment.includesOrg(data, org);
        })!);
    return segment?.offset != null ?
        segment.offset + (org - segment.memory!) : undefined;
  }

  isWritten(offset: number): boolean {
    return this.written.has(offset);
  }
}

function writeString(data: number[], str: string, charmap: Map<string, number[]>) {
  // Split into Unicode code points (not js string UTF-16 code units) so a multi-byte
  // character is one unit for both matching and the unmapped fallback.
  const chars = Array.from(str);
  const maxKeyLen = charmap.size ?
      Math.max(...[...charmap.keys()].map(k => Array.from(k).length)) : 0;
  for (let i = 0; i < chars.length; ) {
    // Greedy longest-match, so a `.strmap` key beats the single-character
    // `.charmap` entries it overlaps.
    let bytes: number[]|undefined;
    let len = Math.min(maxKeyLen, chars.length - i);
    for (; len >= 1; len--) {
      bytes = charmap.get(chars.slice(i, i + len).join(''));
      if (bytes) break;
    }
    if (bytes) {
      data.push(...bytes);
      i += len;
    } else {
      // Unmapped: emit the code point/character itself
      data.push(chars[i].codePointAt(0)! & 0xff);
      i++;
    }
  }
}

type ArgMode =
    'add' | 'a,x' | 'a,y' | // pseudo modes
    'abs' | 'abx' | 'aby' |
    'imm' | 'ind' | 'inx' | 'iny' |
    'rel' | 'zpg' | 'zpx' | 'zpy';

export type Arg = ['acc' | 'imp'] | [ArgMode, Expr];

export interface Options {
  allowBrackets?: boolean;
  reentrantScopes?: boolean;
  overwriteMode?: mod.OverwriteMode;
  refExtractor?: RefExtractor;
  generateDebugInfo?: boolean;
}


type ParsedSymbol = {type: 'pc'|'none'}|{type: 'anon'|'rel'|'rts', num: number};
function parseSymbol(name: string): ParsedSymbol {
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

const ForceDirectAddressingMap : Map<string, ArgMode> = new Map(
  [
    ['add', 'zpg'],
    ['a,x', 'zpx'],
    ['a,y', 'zpy'],
    ['abs', 'zpg'],
    ['abx', 'zpx'],
    ['aby', 'zpy'],
  ]
);

const ForceAbsoluteAddressingMap : Map<string, ArgMode> = new Map(
  [
    ['add', 'abs'],
    ['a,x', 'abx'],
    ['a,y', 'aby'],
    ['zpg', 'abs'],
    ['zpx', 'abx'],
    ['zpy', 'aby'],
  ]
);
