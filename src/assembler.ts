// SPDX-License-Identifier: MPL-2.0

import { Base64 } from './base64.ts';
import { Cpu } from './cpu.ts';
import { type Expr } from './expr.ts';
import * as Exprs from './expr.ts';
import * as mod from './module.ts';
import { ErrorCollector, FatalError, RecoverableError } from './error.ts';
import type { AssemblerMessage, ErrorLevel } from './error.ts';
import { type Token } from './token.ts'
import * as Tokens from './token.ts';
import { Tokenizer } from './tokenizer.ts';
import { Linter, type RtsAnchor } from './lint.ts';
import type { SymbolKind } from './lspindex.ts';
import { applyFeature, UnknownFeatureError, UnsupportedFeatureError,
         type AssemblerOptions } from './options.ts';
import type { LinkTimeEnv } from './latepass.ts';
import { IntervalSet, assertNever, MaxKeySizeCacheMap } from './util.ts';
import { createHash } from 'sha1-uint8array';

// These used to be declared here; keep them exported from this module so
// existing importers (including tests) don't have to change.
export { ErrorCollector, RecoverableError } from './error.ts';
export type { AssemblerOptions as Options } from './options.ts';

type Chunk = mod.ChunkNum; //<number[]>;
type Module = mod.Module;

/**
 * Symbol tag used to store the size of something in the symbol table while
 * keeping it inaccessible to the user. When a scope is closed, or
 * the label's chunk ends, we can create this size symbol in case the user
 * decides to query the size with `.sizeof` later.
 */
const SIZE_NAME = '.size';
const SIZE_SUFFIX = `::${SIZE_NAME}`;

const RE_SCOPE_SPLIT = /::/g;

/** Whether a symbol name is one of the internal size entries described above. */
function isSizeOfSymbol(name: string): boolean {
  return name === SIZE_NAME || name.endsWith(SIZE_SUFFIX);
}

/**
 * ca65 has some predefined segments, and normally this doesn't matter except for
 * using the .code/.bss shortcuts, but for zeropage, we need to also set the
 * addressing mode to `zp` as well.
 */
const PREDECLARED_SEGMENTS = new Map<string, mod.Segment>([
  ['ZEROPAGE', {name: 'ZEROPAGE', addressing: 1}],
]);

const ANON_SEGMENT_ATTR_REASONS = new Map<string, string>([
  ['off', `output offset is determined by the position in the file`],
  ['mem', `PC address is determined by the segment value`],
  ['out', `it always goes to the main output file`],
  ['load', ''],
  ['run', ''],
  ['alignload', ''],
  ['zp', `cannot write to a ram segment`],
  ['zeropage', `cannot write to a ram segment`],
  ['bss', `cannot write to a ram segment`],
  ['optional', ''],
  ['dedupe', ''],
  ['default', `cannot write to a default segment`],
  ['align', `a segment starts where the previous one ended. Use .align instead`],
  ['define', ''],
]);

/**
 * List of CPUs that we support.
 * We aren't very strict about the difference between 6502 and 6502x.
 */
const SUPPORTED_CPUS = new Set(['6502', '6502x']);

const DEFAULT_CPU_NAME = '6502';

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

function firstRef(sym?: Symbol): Tokens.SourceInfo|undefined {
  return sym?.refs?.[0];
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
  /** Whether to record reference+defintion sites on the symbols in this scope. */
  collectRefs?: boolean;

  protected pickScope(name: string,
                      _at?: {source?: Tokens.SourceInfo}): [string, BaseScope] {
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
    const [tail, scope] = this.pickScope(name, ref);
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
    const [tail, scope] = this.pickScope(name, at ?? {source: firstRef(symbol)});
    scope.symbols.set(tail, symbol);
    if (tail !== name) symbol.scoped = true;
    return symbol;
  }
}

class Scope extends BaseScope {
  readonly global: Scope;
  readonly children = new Map<string, Scope>();
  readonly anonymousChildren: Scope[] = [];

  /** Position when the scope was entered, for sizing it on exit. */
  startPc?: Expr;
  /** Name of the label this scope belongs to */
  label?: string;

  constructor(readonly parent?: Scope, readonly kind?: 'scope'|'proc') {
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
  pickScope(name: string, at?: {source?: Tokens.SourceInfo}): [string, Scope] {
    const split = name.split(RE_SCOPE_SPLIT);
    const tail = split.pop()!;
    const found = this.walkScopes(split);
    // If the name has an explicit scope, this is an error?
    if ('missing' in found) {
      Tokens.fail(
          `Could not resolve scope ${split.slice(0, found.missing + 1).join('::')}`,
          at);
    }
    return [tail, found.scope];
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

export interface RefExtractor {
  label?(name: string, addr: number, segments: readonly string[]): void;
  ref?(expr: Expr, bytes: number, addr: number, segments: readonly string[]): void;
  assign?(name: string, value: number): void;
}

export class Assembler {

  /** The currently-open segment(s). */
  private segments: /* readonly */ string[] = [];

  /** Data on all the segments. */
  private segmentData = new Map<string, mod.Segment>();

  /** 
   * Segment name -> current ORG, when we switch segments we need to 
   * set the ORG to the prev value
   */
  private segmentOrg = new Map<string, number>();

  /** Stack of segments for .pushseg/.popseg, with the chunk and its index. */
  private segmentStack:
      Array<readonly [/* readonly */ string[], Chunk|undefined, number,
                      number?]> = [];

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
  /** Names a command-line `-D` defined, which an `.import` may take over. */
  private commandLineDefines = new Set<string>();

  /** Current state for tracking .struct and .enum members */
  private structContext:
      Array<{kind: 'struct'|'enum', offset: number, name?: string, count: number}> = [];

  /**
   * When a `.sizeof` operation is used in a non-const context, we can defer the check
   * and try and see if the size was added later. This is different from ca65 who just
   * errors out, but I think its worth doing this.
   */
  private deferredSizeOfs = new Map<Expr, Scope>();

  /**
   * `.sizeof(label)` is the data declared on the same source line as the label.
   * so we need a flag to track that a label started on this line so we can close
   * the size after the line ends.
   */
  private pendingLabel?: {name: string, startPc: Expr};

  /** Mapping for any string to byte array  */
  private charMapping = new MaxKeySizeCacheMap<string, number[]>();
  /** Saved charmaps for `.pushcharmap`/`.popcharmap`. */
  private charmapStack: Array<MaxKeySizeCacheMap<string, number[]>> = [];

  /**
   * We don't have any CPUs to switch to, so this is just there to make sure the
   * .push/.popcpus match.
   */
  private cpuStack: string[] = [];

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

  /** Index of `_chunk` in `chunks`, or -1 when there is no active chunk. */
  private _chunkIndex = -1;

  /** Name of the next chunk */
  private _name: string|undefined = undefined;

  /** Origin of the currnet chunk, if fixed. */
  private _org: number|undefined = undefined;

  /** Alignment constraint to stamp on the next chunk, from a pending `.align`. */
  private _pendingAlign: number|undefined = undefined;
  /** Fill byte for the pending `.align`, if it specified one. */
  private _pendingFill: number|undefined = undefined;
  /**
   * Chunk that was open when the pending `.align` was seen. If nothing follows
   * the `.align` in that segment, this is the chunk that gets padded.
   */
  private _alignChunk: Chunk|undefined = undefined;

  /** Prefix to prepend to all segment names. */
  private _segmentPrefix = '';

  /** Current source location, for error messages. */
  private _source?: Tokens.SourceInfo;

  /** Debug labels for anonymous/temp labels that aren't in normal symbol tables. */
  private debugLabels: Array<{name: string, expr: Expr}> = [];

  /** Token for reporting errors. */
  private errorToken?: Token;

  /** Flag set by `.end` directive to kill the rest of the file processing. */
  private ended = false;

  /** Collector for errors and messages */
  readonly errorCollector = new ErrorCollector();

  /** Recorded whenever an imported symbol's zp/abs size falls back to a guess. */
  readonly lateAssemblyQueries: mod.LateAssemblyQuery[] = [];

  /** Replayed tokenstream in the latepass. */
  private readonly lateAssemblyStream: Token[][] = [];

  /** Set by the late pass on replay; undefined (and unconsulted) on pass 1. */
  linkEnv?: LinkTimeEnv;

  /** Runs the lint rules, unless linting was turned off. */
  readonly linter?: Linter;

  /** Supports refExtractor. */
  private _exprMap?: WeakMap<Expr, Expr> = undefined;

  /** 
   * When defining segments, this tracks the current offset in the output file
   * That way users don't have to define segment offsets if they are sequential
   */
  private _segmentOffset = 0;

  /** Returns an early error in assembling if you mix segment modes */
  private _segmentMode?: 'named'|'anon';

  constructor(readonly cpu = Cpu.P02, readonly opts: AssemblerOptions = {}) {
    if (opts.collectReferences) {
      this.currentScope.collectRefs = true;
      this.cheapLocals.collectRefs = true;
    }
    if (opts.errorLimit != null) {
      this.errorCollector.limit = opts.errorLimit;
    }
    if (opts.lint?.enabled !== false) {
      this.linter = new Linter(this.errorCollector, opts.lint,
                               opts.tokenizerOptions?.lintPragmas);
    }
  }

  private generateAnonSegmentName(memory: number, size: number): string {
    // reuse _segmentOffset for a count of segments used in this file to help make the hash unique.
    // Prefer the tokenizer's file name over the module name
    // For an `.include`d file that's the file the user actually wrote the `.segment` in.
    const file = this._source?.file ?? this.opts.moduleName ?? '';
    const line = this._source?.line;
    const input = [file, String(line ?? ''), String(this._segmentOffset++),
                   String(memory), String(size)].join('\0');
    const hash = createHash().update(input).digest('hex').slice(0, 12);
    return mod.anonSegmentName(file, line, hash);
  }

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
        this._alignChunk = undefined;
      }
      this._chunk.overwrite = this.overwriteMode;

      // Initialize debug info tracking if enabled
      if (this.opts.generateDebugInfo) {
        this._chunk.sourceMap = new Map();
        this._chunk.labelIndex = new Map();
      }
      // Check the current segments right now to see if we know if this
      // chunk is landing in ZP or ABS. If all of the possible segments for this
      // chunk are labelled as ZP, then this chunk should be in ZP too.
      if (this.segmentsAreZeropage()) {
        this._chunk.zeropage = true;
      }
      this._chunkIndex = this.chunks.length;
      this.chunks.push(this._chunk);
    }
  }

  /** Ends the current chunk, so the next byte emitted starts a new one. */
  private clearChunk() {
    this._chunk = undefined;
    this._chunkIndex = -1;
  }

  private walkSymbolTree(sym: string): Expr|undefined {
    let scope: Scope|undefined = this.currentScope;
    const unscoped = !sym.includes('::');
    do {
      const s = scope.resolve(sym, {allowForwardRef: false});
      if (s) return s.expr;
    } while (unscoped && (scope = scope.parent));
    return undefined;
  }

  definedSymbol(sym: string): boolean {
    // In this case, it's okay to traverse up the scope chain since if we
    // were to reference the symbol, it's guaranteed to be defined somehow.
    if (this.globals.get(sym) === 'import') return true;
    const s = this.walkSymbolTree(sym);
    if (s !== undefined) return Boolean(s);
    return false;
  }

  /**
   * The value is needed by the preprocessor to determine if something
   * is chunk relative. `* - Label` or `Label - Label` is valid,
   * so we need to handle these cases. Resolve the label here, and then
   * if we do math on it later, we can substitute the label again.
   */
  definedValue(sym: string): Expr|undefined {
    if (sym === '*') return this.pc();
    const expr = this.walkSymbolTree(sym);
    // A forward reference is allowed at the spot a label is defined, but if you
    // try to resolve it, then the forward reference needs to be resolvable at this stage.
    // So we need to call `resolve` here to get a numeric value for a label if possible.
    // EX:
    // base = MyLabel   ; Okay (forward ref)
    // test1 = base + 2 ; still okay
    // test2 = base + 3
    // test3 = test2 - test1 ; still still okay since its not used yet
    // ; .if test3 ; not okay since MyLabel is unresolved
    // MyLabel:
    // .if test3  ; okay since MyLabel is resolved.
    return expr && this.resolve(expr);
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

  isMnemonic(name: string): boolean {
    return name.toLowerCase() in this.cpu.table;
  }

  /** ca65 `pc_assignment`: `* = $8000` is sugar for `.org $8000`. */
  allowsPcAssignment(): boolean {
    return Boolean(this.opts.pcAssignment);
  }

  allowsLabelWithoutColon(): boolean {
    // Inside a `.struct`/`.enum` a leading identifier declares a member instead,
    // so the feature doesn't apply there.
    return Boolean(this.opts.labelsWithoutColons) && !this.structContext.length;
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

  /**
   * NOTICE: `pc()` should NOT call `this.chunk()` which would in
   * turn call ensureChunk and materialize a chunk. Users can inadvertently
   * call `pc()` through opening a scope or struct, and if there hasn't been
   * any segments started, this can lead to zero size chunks to get created
   * (which then break linking.) Instead of patching around that in the linker
   * I think it makes more sense to work around it here, by not starting
   * a chunk at `pc()` but set it up to reference whatever the first chunk
   * will be when it's created.
   */
  pc(): Expr {
    const num = this._chunk?.data.length ?? 0;
    const meta: Exprs.Meta = {
      rel: true,
      chunk: this._chunk ? this._chunkIndex : this.chunks.length,
    };
    const org = this._chunk?.org ?? this._org;
    if (org != null) meta.org = org;
    if (this._chunk ? this._chunk.zeropage : this.segmentsAreZeropage()) {
      meta.zeropage = true;
    }
    return Exprs.evaluate({op: 'num', num, meta});
  }

  /** Whether every segment currently selected is a zeropage segment. */
  private segmentsAreZeropage(): boolean {
    return this.segments.length > 0 &&
        this.segments.every(s => this.segmentData.get(s)?.addressing === 1);
  }

  /**
   * When parsing symbols, we will need to be able to both resolve a symbol in the
   * scope, and also size a symbol. Instead of sticking zeropage in as a second
   * param everywhere, we can just roll it together with the symbol lookup.
   * `ref` is an optional callback so the LSP can track every identifier token
   * to its `Symbol` even when the parser inlines an already-defined expr
   */
  private readonly symbolLookup: Exprs.SymbolLookup = {
    get: (name: string) => this.lookupSymbol(name),
    zeropage: (name: string) => this.isZeropageRef(name),
    ref: (name: string, source?: Tokens.SourceInfo): void => {
      if (!source || !this.currentScope.collectRefs) return;
      // Resolve through the same scope walk the assembler would use at eval
      // time, then append the ref on the underlying Symbol.
      const sym = this.lookupSymbol(name);
      if (sym) (sym.refs ??= []).push(source);
    },
  };

  // Returns an expr resolving to a symbol name (e.g. a label)
  symbol(name: string): Expr {
    return Exprs.evaluate(
        Exprs.parseOnly([{token: 'ident', str: name}], 0, this.symbolLookup));
  }

  where(): string {
    if (!this._chunk) return '';
    if (this.chunk.org == null) return '';
    return `${this.chunk.segments.join(',')}:$${
            (this.chunk.org + this.chunk.data.length).toString(16)}`;
  }

  resolve(expr: Expr): Expr {
    const out = Exprs.traverse(expr, (e, rec) => {
      // Need to check to see if we are resolving a `.sizeof` operation here
      // since we don't want the symbol, but the value from symbol.size
      // (so we don't want to run resolveSymbol below is what i mean)
      if (e.op === '.sizeof' && e.args?.length === 1 && e.args[0].sym) {
        const replacement = this.sizeOf(e.args[0].sym);
        if (replacement) return Exprs.evaluate(rec(replacement));
        // Not defined yet - leave it for `resolveSizeOfs` to retry at the end.
        this.deferredSizeOfs.set(e, this.currentScope);
        return e;
      }
      while (e.op === 'sym' && e.sym) {
        e = this.resolveSymbol(e);
      }
      e = this.substituteResolvedRef(e);
      return Exprs.evaluate(rec(e), this.linkEnv);
    });
    if (this.opts.refExtractor?.ref && out !== expr) {
      const orig = this.exprMap.get(expr) || expr;
      this.exprMap.set(out, orig);
    }
    return out;
  }

  /**
   * Walk through a sym ref tree to find the actual value if its available.
   * `seen` is making sure we don't get stuck in a loop for self referential
   * sym refs. We'll eventually run out of refs to check and either return
   * the underlying value or the deepest sym ref we found so far.
   */
  private substituteResolvedRef(expr: Expr): Expr {
    // Called for every node of every traversal, and the loop almost always
    // runs zero or one times, so don't pay for the cycle check until the
    // second hop can actually happen.
    let seen: Set<number>|undefined;
    let first: number|undefined;
    while (expr.op === 'sym' && expr.sym == null && expr.num != null) {
      const num = expr.num;
      if (seen) {
        if (seen.has(num)) break;
        seen.add(num);
      } else if (first === undefined) {
        first = num;
      } else {
        if (first === num) break;
        seen = new Set([first, num]);
      }
      const value = this.symbols[num]?.expr;
      if (!value) break;
      expr = value;
    }
    return expr;
  }

  private defineSizeOfSymbol(scope: Scope, name: string, size: Expr|number) {
    const expr = typeof size === 'number' ?
        {op: 'num', num: size, meta: Exprs.size(size)} : size;
    scope.symbols.set(`${name}${SIZE_SUFFIX}`, {expr});
  }

  private defineSizeOfScope(scope: Scope, name: string|undefined, size: Expr) {
    // The size lives in the scope itself, so `.sizeof(Scope)` finds it by looking
    // up SIZE_NAME there. `.proc` also names a label, which gets the same size.
    scope.symbols.set(SIZE_NAME, {expr: size});
    if (name && scope.parent) this.defineSizeOfSymbol(scope.parent, name, size);
  }

  private sizeOf(name: string): Expr|undefined {
    // A scope stores its size under its own SIZE_NAME entry. `.struct` opens a
    // scope too, so struct tags resolve here as well.
    const scope = this.currentScope.findScope(name);
    if (scope) return scope.symbols.get(SIZE_NAME)?.expr;
    return this.lookupSizeOfSymbol(name)?.expr;
  }

  /**
   * Finds the size symbol of a (possibly qualified) symbol name.
   */
  private lookupSizeOfSymbol(name: string): Symbol|undefined {
    const split = name.split(RE_SCOPE_SPLIT);
    const tail = split.pop()!;
    if (split.length) {
      const owner = this.currentScope.findScope(split.join('::'));
      return owner?.symbols.get(`${tail}${SIZE_SUFFIX}`);
    }
    // Unqualified: search up the scope chain the way symbol lookup does.
    for (let s: Scope|undefined = this.currentScope; s; s = s.parent) {
      const sym = s.symbols.get(`${tail}${SIZE_SUFFIX}`);
      if (sym) return sym;
    }
    return undefined;
  }

  /**
   * Size of a region as an expression resolved through the normal forward-reference handler
   */
  private sizeSpan(startPc: Expr, endPc: Expr): Expr {
    const first = startPc.meta?.chunk;
    const last = endPc.meta?.chunk;
    if (first === last) return {op: '-', args: [endPc, startPc]};
    if (first == null || last == null) {
      this.fail(`Cannot determine size across chunks`, this.errorToken);
    }
    // `pc()` names the chunk the next byte would go into, which may not exist yet, so
    // the start isn't guaranteed to precede the end. It can be a chunk that never got
    // any data, or `.popseg` may have rewound us to an earlier chunk.
    if (first! >= this.chunks.length || first! > last!) {
      const total = this.offsetIn(endPc, last!);
      return {op: 'num', num: total, meta: Exprs.size(total)};
    }
    // If a scope spans across chunks, then we sum up the sizes across all of the chunks
    // that it touches, stopping at the start of the final chunk.
    let total = this.chunkLength(first!) - this.offsetIn(startPc, first!);
    for (let i = first! + 1; i < last!; i++) total += this.chunkLength(i);
    total += this.offsetIn(endPc, last!);
    return {op: 'num', num: total, meta: Exprs.size(total)};
  }

  private chunkLength(chunk: number): number {
    return this.chunks[chunk].data.length;
  }

  /** Byte offset a position expr refers to within its chunk. */
  private offsetIn(pc: Expr, chunk: number): number {
    // `pc()` folds in the chunk's org when one is known, so take it back out.
    return pc.num! - (pc.meta?.rel ? 0 : this.chunks[chunk].org ?? 0);
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
      // That `rts` is a branch target now, so it can't be linted away.
      this.linter?.rtsBackref(i);
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

    const out: Expr = {op: 'sym', num: sym.id};
    if (symbol.meta?.zeropage) out.meta = {zeropage: true};
    return out;
  }

  // No banks are resolved yet.
  chunkData(chunk: number): {org?: number} {
    // TODO - handle zp segments?
    return {org: this.chunks[chunk].org};
  }

  closeScopes() {
    const collector = this.errorCollector;
    // This runs outside `line()`'s recovery net, so hand the collector down and
    // accumulate rather than throwing, matching how the rest of this method
    // reports undefined symbols.
    this.cheapLocals.clear(collector);

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
            collector.add('error', `Symbol '${name}' undefined`, firstRef(sym));
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
            collector.add('error', `Internal error: symbol '${name}' has neither id nor expr`, firstRef(sym));
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

    const globalScope = this.currentScope.global;
    for (const [name, global] of this.globals) {
      // Resolve the symbol in the scope the declaration appeared in and
      // fall back to the global scope if not found.
      const scope = this.globalScopes.get(name) ?? this.currentScope;
      let sym = scope.symbols.get(name);
      // A declaration inside a `.proc`/`.scope` can name a symbol that lives
      // further out - the same lookup an ordinary reference from there does.
      for (let s = scope.parent; s && !sym?.expr; s = s.parent) {
        const outer = s.symbols.get(name);
        if (outer?.expr) sym = outer;
      }
      // `.global` is import-or-export depending on whether it got defined here.
      const kind = global === 'global' ? (sym?.expr ? 'export' : 'import') : global;
      if (kind === 'export') {
        if (!sym?.expr) {
          collector.add('error', `Exported symbol '${name}' undefined`, firstRef(sym));
          continue;
        }
        if (sym.id == null) {
          sym.id = this.symbols.length;
          this.symbols.push(sym);
        }
        sym.export = name;
        // An `.export` inside a `.proc`/`.scope` publishes the name for the
        // whole module, so a reference from outside that scope - which by now
        // has been floated up to the global scope - names this symbol.
        const outer = globalScope.symbols.get(name);
        if (outer && outer !== sym && !outer.expr) {
          outer.expr = {op: 'sym', num: sym.id};
        }
      } else if (kind === 'import') {
        if (!sym) continue; // okay to import but not use.
        // TODO - record both positions?
        if (sym.expr) {
          collector.add('error', `Symbol '${name}' already defined`, firstRef(sym));
          continue;
        }
        // Zeropage imports carry a one-byte size so references pick zp modes.
        const expr: Expr = {op: 'im', sym: name};
        // Carry the reference site so the linker can point at something if the
        // import turns out never to have been exported.
        const at = firstRef(sym);
        if (at) expr.source = at;
        if (this.zeropageGlobals.has(name)) expr.meta = {size: 1};
        sym.expr = expr;
      } else {
        assertNever(kind);
      }
    }

    for (const [name, sym] of this.currentScope.symbols) {
      if (!sym.expr) {
        collector.add('error', `Symbol '${name}' undefined`, firstRef(sym));
      }
    }

    this.resolveSizeOfs();
  }

  /**
   * As part of closing scopes, we need to resolve any deferred size of operations
   * This function was pulled out just for clarities sake, but its really just
   * an extension of `closeScopes`
   */
  private resolveSizeOfs() {
    if (!this.deferredSizeOfs.size) return;
    const saved = this.currentScope;
    const fix = (expr: Expr): Expr => Exprs.traverse(expr, (e, rec) => {
      const scope = this.deferredSizeOfs.get(e);
      if (scope && e.args?.[0]?.sym) {
        const name = e.args[0].sym;
        this.currentScope = scope;
        try {
          const replacement = this.sizeOf(name);
          // Since we've closed all the scopes by now, anything still undefined
          // should throw an error.
          if (!replacement) {
            this.fail(`Size of '${name}' is unknown`, this.errorToken);
          }
          return Exprs.evaluate(this.resolve(replacement!));
        } finally {
          this.currentScope = saved;
        }
      }
      return Exprs.evaluate(rec(e));
    });
    for (const chunk of this.chunks) {
      if (chunk.subs) {
        for (const sub of chunk.subs) sub.expr = fix(sub.expr);
      }
      if (chunk.asserts) chunk.asserts = chunk.asserts.map(fix);
    }
    for (const symbol of this.symbols) {
      if (symbol.expr) symbol.expr = fix(symbol.expr);
    }
    this.deferredSizeOfs.clear();
  }

  module(): Module {
    // A `.align` at the very end of the source still pads its segment in ca65.
    this.flushPendingAlign();
    this.closeScopes();
    // Check for any deferred lints.
    this.linter?.closeModule();

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
    // declaration order is important here because anon segments define their output in order
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

    // Only annotated-abs modules need to re-assemble, so skip the block otherwise.
    const lateAssembly: mod.LateAssembly | undefined = this.lateAssemblyQueries.length ?
        {queries: this.lateAssemblyQueries, stream: this.lateAssemblyStream, opts: this.opts} :
        undefined;

    return {chunks, symbols, segments, debugSymbols, lateAssembly};
  }

  // Assemble from a list of tokens
  line(tokens: Token[]) {
    if (Tokens.eq(tokens[1], Tokens.ASSIGN) ||
        Tokens.eq(tokens[1], Tokens.ASSIGN_LABEL) ||
        Tokens.eq(tokens[1], Tokens.SET)) {
      // Skip over any assignments as these were handled in the preprocessor?
      // TODO: Should the preprocessor remove the tokens?
      return;
    }
    this._source = tokens[0].source;
    const isLabel =
        tokens.length < 3 && Tokens.eq(tokens[tokens.length - 1], Tokens.COLON);

    try {
      // Inside a .struct/.enum, a leading identifier is a member declaration and not
      // an instruction. We still need to watch for `.endstruct` and similar instructions though.
      if (this.structContext.length && tokens[0].token === 'ident') {
        this.structMember(tokens);
      } else if (isLabel) {
        this.label(tokens[0]);
      } else if (tokens[0].token === 'cs') {
        this.directive(tokens);
      } else {
        this.instruction(tokens);
      }
    } catch (err) {
      // `.fatal`, cancellation and the error cap stop the whole run.
      if (err instanceof FatalError) throw err;
      if (err instanceof RecoverableError) {
        // Error already recorded, continue to next line
        return;
      }
      if (err instanceof Tokens.SourceError) {
        // Thrown by Tokens.fail / Exprs.parse / scope lookup, which have no
        // access to the collector. Record it here so there is exactly one
        // message, then resync to the next line.
        this.errorCollector.addFromException(err, err.source ?? this._source);
        return;
      }
      // A plain Error is something not caused by the user, so treat it as fatal
      throw Tokens.SourceError.locate(err, this._source);
    } finally {
      // A label opens its span above; this line is the remainder of the label's
      // source line, so whatever it emitted is the label's size.
      if (!isLabel) this.closeLabelSpan();
    }
  }

  // Assemble from a token source. The optional signal is polled once per line so a long
  // assembly can be cancelled cooperatively; an aborted signal throws, which the caller
  // (compile) turns into an ordinary failure result.
  tokens(source: Tokens.Source, signal?: { readonly aborted: boolean }): void {
    // The `ended` check comes before `next()` so that nothing past `.end` is even tokenized.
    while (!this.ended) {
      const line = source.next();
      if (!line) break;
      if (signal?.aborted) throw new FatalError('Compilation cancelled');
      this.lateAssemblyStream.push(line);
      this.line(line);
    }
  }

  directive(tokens: Token[]) {
    // TODO - record line information, rewrap error messages?
    this.errorToken = tokens[0];
    // Conservatively end the sequence since many directives can emit bytes or change org/seg, so
    // the instructions on either side of it are no longer adjacent.
    this.linter?.endInstructionSequence();
    try {
      switch (Tokens.str(tokens[0])) {
        case '.org': return this.org(this.parseConst(tokens, 1));
        case '.reloc': return this.parseNoArgs(tokens, 1), this.reloc();
        case '.assert': return this.assert(...this.parseAssert(tokens));
        case '.segment': return this.segment(...this.parseSegmentList(tokens, 1, false));
        case '.byte': return this.byte(...this.parseDataList(tokens, true));
        case '.hibytes': return this.byte(...this.parseDataList(tokens).map(e => Exprs.hiByte(e)));
        case '.lobytes': return this.byte(...this.parseDataList(tokens).map(e => Exprs.loByte(e)));
        case '.bytestr': return this.byteInternal(this.parseByteStr(tokens));
        case '.literal': return this.byteInternal(this.parseDataList(tokens, true), new MaxKeySizeCacheMap());
        case '.res': return this.res(...this.parseResArgs(tokens));
        case '.word': return this.word(...this.parseDataList(tokens));
        case '.dbyt': return this.dbyte(...this.parseDataList(tokens));
        case '.faraddr': return this.faraddr(...this.parseDataList(tokens));
        case '.dword': return this.dword(...this.parseDataList(tokens));
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
        case '.pushcharmap': return this.parseNoArgs(tokens, 1), this.pushCharmap();
        case '.popcharmap': return this.parseNoArgs(tokens, 1), this.popCharmap();
        case '.setcpu': return this.setCpu(this.parseStr(tokens, 1));
        case '.pushcpu': return this.parseNoArgs(tokens, 1), this.pushCpu();
        case '.popcpu': return this.parseNoArgs(tokens, 1), this.popCpu();
        case '.asciiz': return this.asciiz(...this.parseDataList(tokens, true));
        case '.align': return this.alignDir(tokens);
        case '.struct': return this.beginStruct(tokens, 'struct');
        case '.union': return this.beginStruct(tokens, 'struct'); // union sized like struct here
        case '.enum': return this.beginStruct(tokens, 'enum');
        case '.endstruct': return this.parseNoArgs(tokens, 1), this.endStruct('struct', tokens[0].source);
        case '.endunion': return this.parseNoArgs(tokens, 1), this.endStruct('struct', tokens[0].source);
        case '.endenum': return this.parseNoArgs(tokens, 1), this.endStruct('enum', tokens[0].source);
        case '.scope': return this.scope(this.parseOptionalIdentifier(tokens), tokens[0].source);
        case '.endscope': return this.parseNoArgs(tokens, 1), this.endScope(tokens[0].source);
        case '.proc': return this.proc(this.parseRequiredIdentifier(tokens), tokens[0].source);
        case '.endproc': return this.parseNoArgs(tokens, 1), this.endProc(tokens[0].source);
        case '.pushseg': return this.pushSeg(...this.parseSegmentList(tokens, 1, true));
        case '.popseg': return this.parseNoArgs(tokens, 1), this.popSeg();
        case '.move': return this.move(...this.parseMoveArgs(tokens));
        case '.end': return this.parseNoArgs(tokens, 1), void (this.ended = true);
        case '.out': return this.log('info', tokens);
        case '.warning': return this.log('warn', tokens);
        case '.error': return this.log('error', tokens);
        case '.fatal': return this.log('error', tokens, true);
        case '.feature': return this.feature(tokens);

        case '.a8':
        case '.i8':
        case '.p02':
          // NOTE: Will need to be actually implemented if 16-bit CPU support is added.
          return;

        // ca65 predeclares these named segments. The attributes come from
        // PREDECLARED_SEGMENTS, so `.zeropage` and `.segment "ZEROPAGE"` are the same thing.
        case '.zeropage': return this.parseNoArgs(tokens, 1), this.segment('ZEROPAGE');
        case '.code': return this.parseNoArgs(tokens, 1), this.segment('CODE');
        case '.data': return this.parseNoArgs(tokens, 1), this.segment('DATA');
        case '.rodata': return this.parseNoArgs(tokens, 1), this.segment('RODATA');
        case '.bss': return this.parseNoArgs(tokens, 1), this.segment('BSS');

        // Directives js65 accepts and deliberately ignores, because the thing
        // they configure either doesn't exist yet or isn't configurable yet.
        // These should probably be fixed at some point.
        case '.list':
        case '.listbytes':
        case '.pagelength':
        case '.fileopt':
        case '.debuginfo':
        case '.linecont':
        case '.localchar':
        case '.case':
        case '.autoimport':
        // Probably not going to add these.
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

  /**
   * Finish collecting the rest of the data on a line for the size of the label
   */
  private closeLabelSpan() {
    const pending = this.pendingLabel;
    if (!pending) return;
    this.pendingLabel = undefined;
    this.defineSizeOfSymbol(
        this.currentScope, pending.name, this.sizeSpan(pending.startPc, this.pc()));
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
    // Something may branch here, so the instruction above no longer simply
    // falls into the one below - but it may have been jumping right here.
    this.linter?.label(ident);
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
      // In ca65, sizeof only references the data on the same source line as the label.
      // so we need to collect the data here into `pendingLabel` and end that when the next
      // line starts. If there's nothing on the line, then the size of the label is zero.
      if (token && (token as Tokens.StringToken).labelsData) {
        this.pendingLabel = {name: ident, startPc: this.pc()};
      } else {
        this.defineSizeOfSymbol(this.currentScope, ident, 0);
      }
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
    this.assignSymbol(ident, false, expr, token, /* isLabel= */ true);
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
    // Set source location before processing the assignment, so anything that
    // fails below is reported against this line.
    if (tokens[0].source) {
      this._source = tokens[0].source;
    }
    const name = Tokens.str(tokens[0]);
    const expr = this.parseExpr(tokens, 2);
    // := marks the sym as a label so it shows up in debuggers
    const isLabel = Tokens.eq(tokens[1], Tokens.ASSIGN_LABEL);
    const ctx = this.structContext[this.structContext.length - 1];
    if (ctx?.kind !== 'enum') {
      this.assign(name, expr, isLabel, tokens[0]);
      return;
    }
    // enum value with assignment, so parse the value passed to the enum.
    // assign will happen in enumMember instead, along with setting the offset
    // to the new value passed in.
    const val = this.evaluate(expr);
    if (val == null) {
      this.fail(`enum member '${name}' needs a constant value`, tokens[0]);
    }
    this.enumMember(name, val, tokens[0]);
  }

  setSym(tokens: Token[]) {
    // Set source location before processing the assignment, so anything that
    // fails below is reported against this line.
    if (tokens[0].source) {
      this._source = tokens[0].source;
    }
    this.set(Tokens.str(tokens[0]), this.parseExpr(tokens, 2), tokens[0]);
  }

  assign(ident: string, expr: Expr|number, isLabel = false, token?: Token,
         kind?: SymbolKind) {
    if (typeof expr !== 'number') expr = this.resolve(expr);
    this.assignSymbol(ident, false, expr, token, isLabel, kind);
    // TODO - no longer needed?
    if (this.opts.refExtractor?.assign && typeof expr === 'number') {
      this.opts.refExtractor.assign(ident, expr);
    }
  }

  set(ident: string, expr: Expr|number, token?: Token) {
    if (ident.startsWith('@')) {
      this.fail(`Cheap locals may only be labels: ${ident}`);
    }
    // Now make the assignment.
    if (typeof expr !== 'number') expr = this.resolve(expr);
    this.assignSymbol(ident, true, expr, token);
  }

  /** 
   * `.set`s a -D value passed in from the CLI, but also marks it as a CLI define
   * That way, if a user imports this value from the linker, we can use the linker
   * value instead of the current ASM `.set` value
   */
  commandLineSet(ident: string, expr: Expr|number) {
    this.set(ident, expr);
    this.commandLineDefines.add(ident);
  }

  assignSymbol(ident: string, mut: boolean, expr: Expr|number, token?: Token,
               isLabel = false, kind?: SymbolKind) {
    // NOTE: * _will_ get current chunk!

    if (typeof expr === 'number') expr = {op: 'num', num: expr, meta: Exprs.size(expr)};

    // Store source info in the expression, used for both debug info output
    // and error message handling
    if (this._source && !expr.source) {
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
      sym = scope.declare(ident, {id: -1}, token);
    } else if (!mut && sym.expr) {
      const orig =
          sym.expr.source ? `\nOriginally defined${Tokens.at(sym.expr)}` : '';
      this.fail(`Redefining symbol ${ident}${orig}`, token);
    }
    sym.expr = expr;
    if (isLabel) sym.isLabel = true;

    if (scope.collectRefs && token?.source) {
      sym.def = token.source;
    }
    this.opts.symbolIndex?.recordSymbol(sym, ident, this.opts.moduleName, kind);

    // Add cheap locals to debugLabels for MLB output.  Constant assignments
    // (`@temp = $05`) aren't positions, so they'd only add bogus entries.
    if (isCheapLocal && isLabel && this.opts.generateDebugInfo) {
      this.debugLabels.push({name: ident, expr});
    }
  }

  instruction(mnemonic: string, arg?: Arg|string): void;
  instruction(tokens: Token[]): void;
  instruction(...args: [Token[]]|[string, (Arg|string)?]): void {
    let mnemonic: string;
    let arg: Arg;
    // The token the mnemonic came from, so an unknown one can be reported
    // against it instead of somewhere upstream.
    let at: Token|undefined;
    // The whole source line, when there was one; the linter reads the operand
    // as written, which the parsed `arg` no longer preserves.
    let tokens: Token[]|undefined;
    if (args.length === 1 && Array.isArray(args[0])) {
      // handle the line...
      tokens = args[0];
      at = tokens[0];
      mnemonic = Tokens.expectIdentifier(tokens[0]).toLowerCase();
      arg = this.parseArg(tokens, 1);
    } else if (typeof args[1] === 'string') {
      // parse the tokens first
      mnemonic = args[0] as string;
      const tokenizer = new Tokenizer(args[1]);
      arg = this.parseArg(tokenizer.next()!, 0);
    } else {
      [mnemonic, arg] = args as [string, Arg];
      if (!arg) arg = ['imp'];
      mnemonic = mnemonic.toLowerCase();
    }
    // Set for an `rts`, so the linter can tell whether anything points at it.
    let rtsAnchor: RtsAnchor|undefined;
    if (mnemonic === 'rts') {
      // NOTE: we special-case this in both the tokenizer and here so that
      // `rts:+` and `rts:-` work for pointing to an rts instruction.
      const expr = this.pc();
      const index = this.rtsRefsReverse.push(expr) - 1;
      const sym = this.rtsRefsForward.shift();
      if (sym != null) this.symbols[sym].expr = expr;
      rtsAnchor = {index, claimed: sym != null};
    }
    // may need to size the arg, depending.
    // cpu will take 'add', 'a,x', and 'a,y' and indicate which it actually is.
    const ops = this.cpu.op(mnemonic);
    if (!ops) this.fail(`Bad mnemonic: ${mnemonic}`, at);
    this.linter?.instruction(mnemonic, arg, ops, tokens, rtsAnchor);
    const m = arg[0];
    if (m === 'add' || m === 'a,x' || m === 'a,y') {
      // Special case for address mnemonics
      let expr = arg[1]!;
      // Before choosing an addressing mode, we need to try and fold any
      // arithmetic to see if the address is known, and if its ZP or ABS
      // This way, a value like $0f + 1 will end up in ZP, but something like
      // $80 + $8000 will end up in ABS still.
      if (expr.meta?.size == null && expr.args) {
        expr = Exprs.traversePost(expr, Exprs.evaluate);
        // A compound expr (`foo+1`) doesn't fold zp-ness through an unresolved
        // import the way a bare `foo` does in `isZeropageRef` - handle it here.
        if (expr.meta?.size == null && !expr.meta?.zeropage) {
          const name = this.unresolvedImportIn(expr);
          if (name) {
            const answer = this.linkEnv?.addrSize(name);
            if (answer != null) {
              expr = {...expr, meta: {...expr.meta, size: answer}};
            } else {
              this.lateAssemblyQueries.push({name, guess: 2, source: expr.source ?? this._source});
            }
          }
        }
      }

      // If the size is unknown, fall back to the operand's address size, which
      // is zeropage only if it was tracked all the way here from the definition.
      const s = expr.meta?.size ?? (expr.meta?.zeropage ? 1 : 2);
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
      // An immediate has no address to size, so catch `lda #a:foo` here rather
      // than letting the expression parser trip over the prefix.
      const size = Tokens.addrSize(tokens, start + 1);
      if (size) {
        this.fail(`Cannot force ${ADDR_SIZE_NAMES[size.size]} addressing on ` +
                  `imm arguments`, tokens[start + 1]);
      }
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
    // A `z:`/`a:` prefix forces the address size of the rest of the operand:
    // `lda z:foo` is zero page even for a symbol we cannot size yet, and
    // `lda a:foo` is absolute even for one we know is in the zero page.
    const forced = Tokens.addrSize(tokens, start);
    if (forced) {
      if (forced.size === 'f') {
        this.fail(`Far addressing (\`f:\`) is 65816-only`, front);
      }
      // Get the rest of the expression and force the addressing mode to the required one
      const [mode, out] = this.parseArg(tokens, forced.next);
      const kind = ADDR_SIZE_NAMES[forced.size];
      if (mode === 'acc' || mode === 'imm' || mode === 'imp') {
        this.fail(`Cannot force ${kind} addressing on ${mode} arguments`, front);
      }
      const lookup = forced.size === 'z' ?
          ForceDirectAddressingMap : ForceAbsoluteAddressingMap;
      const adr = lookup.get(mode);
      if (!adr) this.fail(`Cannot force ${kind} addressing on ${mode} arguments`, front);
      return [adr, out!];
    }
    // it must be an address of some sort - is it indirect?
    if (Tokens.eq(front, Tokens.LP) ||
        (this.opts.allowBrackets && Tokens.eq(front, Tokens.LB))) {
      const close = Tokens.findBalanced(tokens, start);
      if (close < 0) this.fail(`Unbalanced ${Tokens.name(front)}`, front);
      const args = Tokens.parseArgList(tokens, start + 1, close);
      if (!args.length) this.fail(`Bad argument`, front);
      // Every 6502 indirect mode has a fixed operand size, so an address size
      // inside the parens can only ever agree with it: accept and ignore it,
      // rather than failing on ca65 sources that spell out `(z:ptr),y`.
      const inner = args[0];
      const innerSize = Tokens.addrSize(inner, 0);
      if (innerSize?.size === 'f') {
        this.fail(`Far addressing (\`f:\`) is 65816-only`, inner[0]);
      }
      const expr = this.parseExpr(inner, innerSize?.next ?? 0);
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
    const meta: Exprs.Meta = {rel: true, chunk: this._chunkIndex};
    if (this._chunk?.org) meta.org = this._chunk.org;
    const nextPc = {op: 'num', num, meta};
    // Mark the subtraction as a branch for signed range checking
    const rel: Expr = {op: '-', args: [expr, nextPc], meta: {branch: true}};
    if (expr.source) rel.source = expr.source;
    this.opcode(op, arglen, rel);
  }

  opcode(op: number, arglen: number, expr: Expr) {
    // Emit some bytes.
    // Performing the resolve will remove the branch tag on the expression,
    // so save it so we can pass it down later
    const isBranch = Boolean(expr?.meta?.branch);
    if (arglen) expr = this.resolve(expr); // BEFORE opcode (in case of *)
    const {chunk} = this;
    this.markWritten(1 + arglen);

    // Record source info for this instruction
    if (this.opts.generateDebugInfo && this._chunk?.sourceMap && this._source) {
      this._chunk.sourceMap.set(chunk.data.length, this._source);
    }

    chunk.data.push(op);
    if (arglen) {
      this.append(expr, arglen, isBranch);
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

  append(expr: Expr, size: number, isBranch?: boolean) {
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
      const sub: mod.Substitution = {offset, size, expr};
      // The linker is what range-checks a substituted value, so the feature has
      // to ride along with the substitution to get there.
      if (this.opts.forceRange) sub.forceRange = true;
      (chunk.subs || (chunk.subs = [])).push(sub);
      this.writeNumber(chunk.data, size); // write goes after subs
    } else {
      this.writeNumber(chunk.data, size, val, isBranch);
    }
  }

  ////////////////////////////////////////////////////////////////
  // Directive handlers

  org(addr: number, name?: string) {
    if (this._org != null && this._chunk != null &&
      this._org + this._chunk.data.length === addr) {
      return; // nothing to do?
    }
    this.flushPendingAlign();
    this._org = addr;
    this.clearChunk();
    this._name = name;
  }

  reloc(name?: string) {
    this.flushPendingAlign();
    this._org = undefined;
    this.clearChunk();
    this._name = name;
  }

  private setSegmentMode(mode: 'named'|'anon', at?: Token) {
    if (this._segmentMode && this._segmentMode !== mode) {
      this.fail(mode === 'anon'
          ? `Cannot use an anonymous .segment after a named .segment; ` +
            `a module uses one style or the other`
          : `Cannot use a named .segment after an anonymous .segment; ` +
            `a module uses one style or the other`, at);
    }
    this._segmentMode = mode;
  }

  segment(...segments: Array<string|mod.Segment>) {
    // Usage: .segment "1a", "1b", ...
    for (const s of segments) {
      this.setSegmentMode(mod.Segment.isAnon(s) ? 'anon' : 'named');
    }
    // A trailing `.align` belongs to the segment it appeared in, so pad it out
    // here rather than letting it leak onto the next segment's chunk.
    this.flushPendingAlign();
    this.saveSegmentOrg();
    this.segments = segments.map(s => typeof s === 'string' ? s : s.name);
    for (const s of segments) {
      const name = typeof s === 'string' ? s : s.name;
      let data = this.segmentData.get(name);
      if (!data) {
        // Copy, so that later merges/`.free` don't mutate the shared template.
        const predeclared = PREDECLARED_SEGMENTS.get(name);
        if (predeclared) this.segmentData.set(name, data = {...predeclared});
      }
      if (typeof s === 'object') {
        this.segmentData.set(name, mod.Segment.merge(data || {name}, s));
      }
    }
    this.clearChunk();
    this._name = undefined;
    // `.org` is per-segment, so the previous segment's address doesn't carry
    // over. Pick up this segment's own PC, or `.reloc` if it never had one.
    this._org = this.segmentOrg.get(this.segmentKey());
    // An anonymous segment's positional address doubles as an implicit `.org`
    if (this._org == null &&
        segments.length === 1 && typeof segments[0] === 'object' &&
        mod.Segment.isAnon(segments[0]) && segments[0].memory != null) {
      this._org = segments[0].memory;
    }
  }

  private segmentKey(): string {
    return this.segments.join('\0');
  }

  private saveSegmentOrg() {
    const key = this.segmentKey();
    if (this._org == null) {
      this.segmentOrg.delete(key);
      return;
    }
    this.segmentOrg.set(key, this.orgPc());
  }

  /** Current PC, which is only meaningful in `.org` mode. */
  private orgPc(): number {
    return (this._chunk?.org ?? this._org!) + (this._chunk?.data.length ?? 0);
  }

  assert(expr: Expr, _level?: string, message?: string) {
    this.linter?.assert();
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
    if (name != null) this.enterScope(name, 'scope', tokens[0].source);
    this.structContext.push({kind, offset: 0, name: name ?? undefined, count: 0});
  }

  endStruct(kind: 'struct'|'enum', at?: Tokens.SourceInfo) {
    const ctx = this.structContext.pop();
    if (!ctx || ctx.kind !== kind) this.fail(`.end${kind} without a matching .${kind}`);
    if (ctx!.name != null) {
      // The size of the structs are stored in the offset, while
      // the size of the enum is the count of the fields because ... it just is.
      // i guess its useful, but still!
      const num = ctx!.kind === 'enum' ? ctx!.count : ctx!.offset;
      const size: Expr = {op: 'num', num, meta: Exprs.size(num)};
      this.defineSizeOfScope(this.currentScope, ctx!.name, size);
      this.exitScope('scope', at);
    }
  }

  structMember(tokens: Token[]) {
    const ctx = this.structContext[this.structContext.length - 1];
    const name = Tokens.str(tokens[0]);
    if (ctx.kind === 'enum') {
      // No explicit value, so the member takes the running counter in offset.
      Tokens.expectEol(tokens[1]);
      this.enumMember(name, ctx.offset, tokens[0]);
      return;
    }
    this.assign(name, ctx.offset, false, tokens[0], 'structMember');
    const size = this.structMemberSize(tokens);
    // The member's own symbol holds its offset, so its width goes in a size symbol.
    this.defineSizeOfSymbol(this.currentScope, name, size);
    ctx.offset += size;
  }

  private enumMember(name: string, value: number, token?: Token) {
    const ctx = this.structContext[this.structContext.length - 1];
    this.assign(name, value, false, token, 'enumMember');
    this.defineSizeOfSymbol(this.currentScope, name, 1);
    ctx.offset = value + 1;
    ctx.count++;
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
      const expr = this.sizeOf(structName);
      const sz = expr != null ? this.evaluate(expr) : undefined;
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
      const pad = (boundary - (this.orgPc() % boundary)) % boundary;
      if (pad) this.res(pad, fill);
      return;
    }
    // Relocatable mode means we just delay this until link time instead.
    if (this._pendingAlign == null) this._alignChunk = this._chunk;
    this._pendingAlign = Math.max(this._pendingAlign ?? 1, boundary);
    this._pendingFill = fill ?? this._pendingFill;
    this.clearChunk();
  }

  /**
   * If an `.align` was used at the end of a chunk, and no data follows it,
   * then we need to align the current chunk. This needs to be called whenever
   * starting a new chunk then to see if we need to align the old one, and then
   * clearing the pending alignment.
   */
  private flushPendingAlign() {
    const boundary = this._pendingAlign;
    const fill = this._pendingFill;
    const chunk = this._alignChunk;
    this._pendingAlign = undefined;
    this._pendingFill = undefined;
    this._alignChunk = undefined;
    if (boundary == null || !chunk?.data.length) return;
    // A relocatable chunk that must end on a boundary must also start on one,
    // so padding its length up to a multiple leaves the end aligned as well.
    const pc = chunk.org != null ? chunk.org + chunk.data.length : chunk.data.length;
    const pad = (boundary - (pc % boundary)) % boundary;
    if (chunk.org == null) chunk.align = Math.max(chunk.align ?? 1, boundary);
    for (let i = 0; i < pad; i++) chunk.data.push(fill ?? 0);
  }

  // CA65 compatible 1:1 character mapping. Given a single char byte or a byte literal,
  // converts it to the output value. This applies to any characters in any strings
  charmap(tokens: Token[]) {
    const args = Tokens.parseArgList(tokens, 1);
    if (args.length !== 2) this.fail(`.charmap expects an index and a value`, tokens[0]);
    const code = this.parseConst(args[0], 0);
    const target = this.parseConst(args[1], 0);
    this.charMap(code, target);
  }

  charMap(code: number, target: number) {
    if (code < 0 || code > 255) this.fail(`.charmap index out of range: ${code}`);
    this.charMapping.set(String.fromCodePoint(code), [target & 0xff]);
  }

  pushCharmap() {
    this.charmapStack.push(new MaxKeySizeCacheMap(this.charMapping));
  }

  popCharmap() {
    this.charMapping = this.charmapStack.pop() ?? this.charMapping;
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
    this.strMap(key, bytes);
  }

  strMap(key: string, bytes: number[]) {
    if (!key) this.fail(`.strmap key must not be empty`);
    if (!bytes.length) this.fail(`.strmap value must not be empty`);
    this.charMapping.set(key, bytes.map(b => b & 0xff));
  }

  // the `charMap` parameter defaults to the current charMap, but for `.literal`
  // we pass in an empty map to disable the charMapping for this string.
  byteInternal(args: Array<Expr|string|number>,
               charmap: MaxKeySizeCacheMap<string, number[]> = this.charMapping) {
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
        writeString(chunk.data, arg, charmap);
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

  /** `.faraddr`: a 24-bit little-endian address. */
  faraddr(...args: Array<Expr|number>) {
    const {chunk} = this;
    this.markWritten(3 * args.length);

    for (const arg of args) {
      if (this.opts.generateDebugInfo && this._chunk?.sourceMap && this._source) {
        for (let i = 0; i < 3; i++) {
          this._chunk.sourceMap.set(chunk.data.length + i, this._source);
        }
      }
      if (typeof arg === 'number') {
        this.writeNumber(chunk.data, 3, arg);
      } else {
        this.append(arg, 3);
      }
    }
  }

  // `.dbyt` is a big-endian word, but substitutions only work in little endian.
  // So we need to split this into a `.hiByte` and `.loByte` pair if this is
  // a forward reference that will be substituted in later.
  dbyte(...args: Array<Expr|number>) {
    const {chunk} = this;
    this.markWritten(2 * args.length);

    for (const arg of args) {
      // Record source info for each byte of the word (2 bytes)
      if (this.opts.generateDebugInfo && this._chunk?.sourceMap && this._source) {
        this._chunk.sourceMap.set(chunk.data.length, this._source);
        this._chunk.sourceMap.set(chunk.data.length + 1, this._source);
      }
      if (typeof arg === 'number') {
        this.writeNumber(chunk.data, 1, arg >> 8);
        this.writeNumber(chunk.data, 1, arg);
      } else {
        this.append(Exprs.hiByte(arg), 1);
        this.append(Exprs.loByte(arg), 1);
      }
    }
  }

  dword(...args: Array<Expr|number>) {
    const {chunk} = this;
    this.markWritten(4 * args.length);

    for (const arg of args) {
      // Record source info for each byte of the dword (4 bytes)
      if (this.opts.generateDebugInfo && this._chunk?.sourceMap && this._source) {
        for (let i = 0; i < 4; i++) {
          this._chunk.sourceMap.set(chunk.data.length + i, this._source);
        }
      }
      if (typeof arg === 'number') {
        this.writeNumber(chunk.data, 4, arg);
      } else {
        this.append(arg, 4);
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
    this.clearChunk();
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

  /**
   * Whether a reference to `name` from the current scope lands in the zeropage.
   * Steps through the scope tree to try and find the symbol in parent scopes
   * so we can properly size it.
   */
  private isZeropageRef(name: string): boolean {
    if (this.zeropageGlobals.has(name)) return true;
    const zp = Boolean(this.lookupSymbol(name)?.expr?.meta?.zeropage);
    // A plain `.import` should be abs, but maybe they meant .importzp
    // the linker may know better once every module is loaded, so query it.
    if (!zp && this.globals.get(name) === 'import') {
      const answer = this.linkEnv?.addrSize(name);
      if (answer != null) return answer === 1;
      this.lateAssemblyQueries.push({name, guess: 2, source: this._source});
    }
    return zp;
  }

  /** The name of an unresolved `.import` reachable through +/- from `expr`, if any. */
  private unresolvedImportIn(expr: Expr): string|undefined {
    if (expr.op === 'sym' || expr.op === 'im') {
      const name = expr.sym;
      return name && this.globals.get(name) === 'import' && !this.zeropageGlobals.has(name) ?
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

  /**
   * Run through the scope tree looking for the named symbol without
   * creating a forward reference if its not found. We need to walk
   * through the tree here to see if we can properly size the value
   * now instead of deferring it to link time which would force this
   * to get pessimized to an ABS addressing mode.
   */
  private lookupSymbol(name: string): Symbol|undefined {
    if (name.charCodeAt(0) === 0x40 /* @ */) {
      return this.cheapLocals.symbols.get(name);
    }
    // This runs for every identifier in every expression, so shortcut
    // checking for the symbol if it isn't explicitly scoped and jump
    // straight to the symbol map lookup.
    if (name.indexOf(':') < 0 || !name.includes('::')) {
      for (let scope: Scope|undefined = this.currentScope; scope;
           scope = scope.parent) {
        const sym = scope.symbols.get(name);
        if (sym?.expr) return sym;
        if (sym?.scoped) return sym; // explicitly scoped: no outer name applies
      }
      return undefined;
    }
    try {
      return this.currentScope.resolve(name, {allowForwardRef: false});
    } catch {
      // An unresolvable explicit scope shouldn't throw here. The symbol
      // gets resolved for real (and fails there) once the operand is emitted.
      return undefined;
    }
  }

  private declareGlobal(ident: string, kind: 'export'|'import'|'global', weak = false) {
    if (weak && this.globals.has(ident)) return;
    // Use the linker version of the -D cli define instead of the global .set version
    if (kind === 'import' && this.commandLineDefines.delete(ident)) {
      this.currentScope.global.symbols.delete(ident);
    }
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

  scope(name?: string, at?: Tokens.SourceInfo) {
    this.enterScope(name, 'scope', at);
  }

  proc(name: string, at?: Tokens.SourceInfo) {
    this.label(name);
    this.enterScope(name, 'proc', at);
    this.linter?.enterProc(name);
    // the size for the proc should match the scope, so give the scope the name of the label
    // we just made so that it works properly
    this.currentScope.label = name;
  }

  enterScope(name: string|undefined, kind: 'scope'|'proc', at?: Tokens.SourceInfo) {
    const existing = name ? this.currentScope.children.get(name) : undefined;
    if (existing) {
      if (this.opts.reentrantScopes) {
        this.currentScope = existing;
        this.opts.symbolIndex?.enterScope(name, kind, at);
        return;
      }
      this.fail(`Cannot re-enter scope ${name}`);
    }
    const child = new Scope(this.currentScope, kind);
    child.startPc = this.pc();
    if (name) {
      this.currentScope.children.set(name, child);
    } else {
      this.currentScope.anonymousChildren.push(child);
    }
    this.currentScope = child;
    this.opts.symbolIndex?.enterScope(name, kind, at);
  }

  endScope(at?: Tokens.SourceInfo) { this.exitScope('scope', at); }
  endProc(at?: Tokens.SourceInfo) { this.exitScope('proc', at); }

  exitScope(kind: 'scope'|'proc', at?: Tokens.SourceInfo) {
    if (this.currentScope.kind !== kind || !this.currentScope.parent) {
      this.fail(`.end${kind} without .${kind}`);
    }
    // Reported against the `.endproc`, which is what the fix goes in front of.
    if (kind === 'proc') this.linter?.exitProc(at);
    const scope = this.currentScope;
    if (scope.startPc && !scope.symbols.has(SIZE_NAME)) {
      this.defineSizeOfScope(scope, scope.label, this.sizeSpan(scope.startPc, this.pc()));
    }
    this.currentScope = scope.parent!;
    this.opts.symbolIndex?.exitScope(at);
  }

  pushSeg(...segments: Array<string|mod.Segment>) {
    this.preventInvalidAnonSegChange('.pushseg');
    this.flushPendingAlign();
    this.segmentStack.push(
        [this.segments, this._chunk, this._chunkIndex, this._org]);
    // If pushseg was called without any segments, just keep the current segment
    if (segments.length) {
      this.segment(...segments);
    }
  }

  popSeg() {
    this.preventInvalidAnonSegChange('.popseg');
    if (!this.segmentStack.length) this.fail(`.popseg without .pushseg`);
    this.flushPendingAlign();
    this.saveSegmentOrg();
    let org: number|undefined;
    [this.segments, this._chunk, this._chunkIndex, org] =
        this.segmentStack.pop()!;
    this._org = this._chunk?.org ?? org;
  }

  private preventInvalidAnonSegChange(directive: string) {
    if (this._segmentMode === 'anon') {
      this.fail(`${directive} cannot be used with anonymous segments; ` +
                `they are sequential file positions, not a stack`);
    }
  }

  setCpu(name: string) {
    if (!SUPPORTED_CPUS.has(name.toLowerCase())) {
      this.fail(`Unsupported CPU: ${name}`);
    }
  }

  pushCpu() {
    this.cpuStack.push(DEFAULT_CPU_NAME);
  }

  popCpu() {
    if (!this.cpuStack.length) this.fail(`.popcpu without .pushcpu`);
    this.cpuStack.pop();
  }

  /** .feature name [on|off|+|-] [, name [on|off|+|-] ...] */
  feature(tokens: Token[]) {
    if (tokens.length < 2) this.fail(`Expected feature name(s)`, tokens[0]);
    // no tokenizerOptions is a valid case when doing tests or getting used as a library
    const tokOpts = this.opts.tokenizerOptions ?? {};
    for (const term of Tokens.parseArgList(tokens, 1)) {
      const nameTok = term[0];
      const name = Tokens.expectIdentifier(nameTok, tokens[0]);
      const on = this.parseFeatureState(term, nameTok);
      try {
        applyFeature(name, this.opts, tokOpts, on);
      } catch (err) {
        if (err instanceof RecoverableError) {
          this.errorCollector.add('warning', err.message, this._source);
          continue;
        }
        if (err instanceof UnknownFeatureError) {
          this.fail(`Unknown feature: ${err.message}`, nameTok);
        }
        if (err instanceof UnsupportedFeatureError) {
          this.fail(`Unsupported feature: ${err.message}`, nameTok);
        }
        throw err;
      }
    }
  }

  /** The optional `on`/`off`/`+`/`-` trailing a name in `.feature`. */
  private parseFeatureState(term: Token[], nameTok: Token): boolean {
    if (term.length === 1) return true;
    const tok = term[1];
    if (term.length === 2) {
      if (tok.token === 'ident') {
        const state = Tokens.str(tok).toLowerCase();
        if (state === 'on') return true;
        if (state === 'off') return false;
      }
      // `+`/`-` tokenize as operators, and RE_OPERATOR is greedy about runs of
      // them, so only a single character counts.
      if (tok.token === 'op') {
        if (tok.str === '+') return true;
        if (tok.str === '-') return false;
      }
    }
    this.fail(`Expected on, off, + or - after feature name`, tok ?? nameTok);
  }

  move(size: number, source: Expr) {
    this.append({op: '.move', args: [source], meta: {size}}, size);
  }

  log(level: 'info'|'warn'|'error', line: Token[], fatal = false) {
    const str = Tokens.expectString(line[1], line[0]);
    Tokens.expectEol(line[2], 'a single string');
    const source = line[0].source;

    // Don't add the error to the error collector if its from `.fatal`
    // since its unrecoverable.
    if (fatal) throw new FatalError(str, source);

    // Map 'warn' to 'warning' for ErrorLevel
    const errorLevel: ErrorLevel = level === 'warn' ? 'warning' : level;
    this.errorCollector.add(errorLevel, str, source);

    if (level === 'error') {
      // For .error directive, record and throw to stop processing this line
      throw new RecoverableError(str, source);
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
    return Exprs.parseOnly(tokens, start, this.symbolLookup, this.encodeChar);
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

  /**
   * A boolean segment attribute. If a param is not provided, it defaults to true
   * otherwise is uses the value after it (as a const value).
   */
  parseFlag(tokens: Token[], key: string): boolean {
    if (!tokens.length) return true;
    const val = this.parseConst(tokens, 0);
    if (val !== 0 && val !== 1) {
      this.fail(`Segment attr ${key} must be 0 or 1: ${val}`, tokens[0]);
    }
    return val !== 0;
  }

  /** An alignment segment attribute which must be a positive power of two. */
  parseAlign(tokens: Token[], key: string): number {
    if (!tokens.length) this.fail(`Segment attr ${key} needs a value`);
    const val = this.parseConst(tokens, 0);
    if (val < 1 || (val & (val - 1)) !== 0) {
      this.fail(`Segment attr ${key} must be a power of two: ${val}`, tokens[0]);
    }
    return val;
  }

  parseSegmentList(tokens: Token[], start: number, allowEmptySegmentList: boolean): Array<string|mod.Segment> {
    if (tokens.length < start + 1) {
      if (allowEmptySegmentList) {
        return [];
      }
      this.fail(`Expected a segment list`, tokens[start - 1]);
    }
    if (tokens.find(t => t.token == 'op' && t.str == '&')) {
      return this.parseShorthandMirroredSegment(tokens);
    }

    return Tokens.parseArgList(tokens, 1).map((ts, _i, all) => {
      // `.segment $8000 :size $4000` - an address rather than a name.
      if (ts[0]?.token === 'num') return this.parseAnonSegment(ts, all.length);
      const str = this._segmentPrefix + Tokens.expectString(ts[0]);
      // Check the composed name so `.segmentprefix "@"` can't smuggle one in.
      if (str.startsWith(mod.RESERVED_SEGMENT_PREFIX)) {
        this.fail(
            `Segment name may not start with '${mod.RESERVED_SEGMENT_PREFIX}', which is reserved: ${str}`,
            ts[0]);
      }
      if (ts.length === 1) return str;
      if (!Tokens.eq(ts[1], Tokens.COLON)) {
        this.fail(`Expected comma or colon: ${Tokens.name(ts[1])}`, ts[1]);
      }
      let nonCompositeAttrSeen = false;
      const seg = {name: str} as mod.Segment;
      // TODO - parse expressions...
      const attrs = Tokens.parseAttrList(ts, 1); // : ident [...]
      for (const [key, val] of attrs) {
        if (key !== 'mirror' && key !== 'pool') {
          nonCompositeAttrSeen = true;
        }
        switch (key) {
          case 'bank': seg.bank = this.parseConst(val, 0); break;
          case 'size': seg.size = this.parseConst(val, 0); break;
          case 'off': seg.offset = this.parseConst(val, 0); break;
          case 'mem': seg.memory = this.parseConst(val, 0); break;
          // `:fill` with no value fills with zeros, like ld65's `fill = yes`.
          case 'fill': seg.fill = val.length ? this.parseConst(val, 0) : 0; break;
          case 'out': seg.out = this.parseOptionalStr(val, 0) ?? '%O'; break;
          case 'align': seg.align = this.parseAlign(val, key); break;
          case 'alignload': seg.alignLoad = this.parseAlign(val, key); break;
          case 'load': seg.load = this.parseStr(val, 0); break;
          case 'run': seg.run = this.parseStr(val, 0); break;
          // ld65's `type = zp` is both an addressing size and a bss segment.
          case 'zp': case 'zeropage': seg.addressing = 1; seg.bss = true; break;
          case 'bss': seg.bss = this.parseFlag(val, key); break;
          case 'define': seg.define = this.parseFlag(val, key); break;
          case 'optional': seg.optional = this.parseFlag(val, key); break;
          case 'dedupe': seg.dedupe = this.parseFlag(val, key); break;
          case 'default': seg.default = this.parseFlag(val, key); break;
          // js65 has no read-only concept, so accept and ignore ld65's types.
          case 'ro': case 'rw': break;
          case 'mirror':
            seg.mirror = this.parseSegmentNameList(val, key, ts[1]);
            break;
          case 'pool':
            seg.pool = this.parseSegmentNameList(val, key, ts[1]);
            break;
          default: this.fail(`Unknown segment attr: ${key}`);
        }
      }
      if (seg.mirror && seg.pool) {
        this.fail(`A segment may not have both \`:mirror\` and \`:pool\``, ts[1]);
      }
      if (nonCompositeAttrSeen && (seg.mirror || seg.pool)) {
        this.fail(`Cannot use other segment attributes when \`:${
            seg.mirror ? 'mirror' : 'pool'}\` is used`, ts[1]);
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

  parseSegmentNameList(val: Token[], key: string, at?: Token): string[] {
    const grp = val.length === 1 && val[0].token === 'grp' ? val[0] : undefined;
    if (!grp) {
      this.fail(`Segment attr ${key} expects a braced list: :${key} {"A", "B"}`,
                at);
    }
    const names: string[] = [];
    for (const tok of grp.inner) {
      if (Tokens.eq(tok, Tokens.COMMA)) continue;
      if (tok.token !== 'str') {
        this.fail(`Segment attr ${key} expects a list of segment name strings`,
                  tok);
      }
      names.push(tok.str);
    }
    return this.checkCompositeMembers(names, key, at);
  }

  private checkCompositeMembers(names: string[], key: string,
                              at?: Token): string[] {
    if (names.length < 2) {
      this.fail(`Segment attr ${key} needs at least two segments: ${
          names.length ? names.join(', ') : '(empty)'}`, at);
    }
    const prefixed = names.map(n => this._segmentPrefix + n);
    if (new Set(prefixed).size !== prefixed.length) {
      this.fail(`Segment attr ${key} contains a duplicate segment: ${
          prefixed.join(', ')}`, at);
    }
    return prefixed;
  }

  /**
   * Parses an anonymous segment: `.segment $8000 :size $4000 [:fill <$ff>]`.
   *
   * The positional address is the segment's `memory`. There is deliberately no
   * `offset` parameter. Anonymous segments are laid out sequentially by the
   * linker in module-read order.
   */
  parseAnonSegment(ts: Token[], argCount: number): mod.Segment {
    if (argCount > 1) {
      this.fail(`An anonymous .segment may not appear in a comma-separated list`,
                ts[0]);
    }
    const colon = Tokens.find(ts, Tokens.COLON, 0);
    if (colon < 0) {
      this.fail(`An anonymous .segment requires :size`, ts[0]);
    }
    // allow math expressions in the PC address
    const memory = this.parseConst(ts.slice(0, colon), 0);

    let size: number|undefined;
    let fill: number|undefined;
    let bank: number|undefined;
    for (const [key, val] of Tokens.parseAttrList(ts, colon)) {
      const rejected = ANON_SEGMENT_ATTR_REASONS.get(key);
      if (rejected != null) {
        this.fail(`Segment attr ${key} is not allowed on an anonymous .segment` +
                  (rejected ? `: ${rejected}` : ''), ts[0]);
      }
      switch (key) {
        case 'size': size = this.parseConst(val, 0); break;
        // `:fill` with no value fills with zeros, like ld65's `fill = yes`.
        case 'fill': fill = val.length ? this.parseConst(val, 0) : 0; break;
        // Pure metadata, for `^` bank-byte exprs and LinkSegment.bank.
        case 'bank': bank = this.parseConst(val, 0); break;
        // js65 has no read-only concept, so accept and ignore ld65's types.
        case 'ro': case 'rw': break;
        default: this.fail(`Unknown segment attr: ${key}`, ts[0]);
      }
    }
    if (size === undefined) {
      this.fail(`An anonymous .segment requires :size`, ts[0]);
    }

    const seg: mod.Segment = {name: this.generateAnonSegmentName(memory, size), memory, size};
    if (bank !== undefined) seg.bank = bank;
    if (fill !== undefined) {
      seg.fill = fill;
      seg.free = [[memory, memory + size]];
    }

    return seg;
  }

  /**
   * .segment "A" & "B" & ... "Z" ; is shorthand for
   * .segment "A&B&...&Z" :mirror {"A", "B", ... "Z"}
   * No commas are allowed in this as the data should be mirrored into all segments listed
   * Loads or creates a segment with the `:mirrored` attribute and returns just that one segment
   */
  parseShorthandMirroredSegment(ts: Token[]): Array<string|mod.Segment> {
    // Find the list of named segments and reject if we have any attributes or commas
    // skipping over the first `.segment` token
    const segnames = ts.slice(1).filter(t => !(t.token === 'op' && t.str === '&'))
                                .map( t => Tokens.expectString(t) ).sort();
    const mirror = this.checkCompositeMembers(segnames, 'mirror', ts[0]);
    const seg: mod.Segment = {
      name: mirror.join('&'),
      mirror,
    };
    return [seg];
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

  writeNumber(data: number[], size: number, val?: number, isBranch?: boolean) {
    if (val != null && !this.opts.forceRange && !Exprs.fits(val, size, isBranch)) {
      // We have to write the bytes even if this should error out so that the
      // rest of the error diagnostics match up correctly.
      this.errorCollector.add(
          'error', Exprs.rangeErrorMessage(val, size, isBranch), this._source);
    }
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

function writeString(data: number[], str: string, charmap: MaxKeySizeCacheMap<string, number[]>) {
  // Split into Unicode code points (not js string UTF-16 code units) so a multi-byte
  // character is one unit for both matching and the unmapped fallback.
  const chars = Array.from(str);
  const maxKeyLen = charmap.getLargestKeySize();
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

const ADDR_SIZE_NAMES = {z: 'direct', a: 'absolute', f: 'far'} as const;

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
