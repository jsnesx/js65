// SPDX-License-Identifier: MPL-2.0

import type {FoldingRange, SemanticTokens} from 'vscode-languageserver-protocol';
import {Tokenizer} from '../../../../src/tokenizer.ts';

import type {Token} from '../../../../src/token.ts';
import {Cpu} from '../../../../src/cpu.ts';
import {blankJsBlocks} from './jsblocks.ts';

/** Open/close pairs for folding. `open`/`close` are the `.cs` strings. */
const FOLD_PAIRS: ReadonlyArray<{open: string, close: string}> = [
  {open: '.scope', close: '.endscope'},
  {open: '.proc', close: '.endproc'},
  {open: '.macro', close: '.endmacro'},
  {open: '.repeat', close: '.endrep'},
  {open: '.struct', close: '.endstruct'},
  {open: '.enum', close: '.endenum'},
];

/**
 * Compute folding ranges by lexing the document and matching open/close pairs
 * via a stack. Errors during lexing just stop the stream where they are.
 * Folding is best-effort on broken text.
 */
export function computeFolding(text: string): FoldingRange[] {
  const lines = lexAllLines(text);
  const out: FoldingRange[] = [];
  const stack: Array<{open: string, line: number}> = [];
  for (const entry of lines) {
    const first = firstCs(entry.tokens);
    if (!first) continue;
    for (const pair of FOLD_PAIRS) {
      if (first === pair.open) {
        stack.push({open: pair.open, line: entry.line});
      } else if (first === pair.close) {
        // Pop the nearest matching open (tolerant to mismatched closes).
        for (let j = stack.length - 1; j >= 0; j--) {
          if (FOLD_PAIRS.find(p => p.open === stack[j].open)?.close === first) {
            const top = stack.splice(j, 1)[0];
            if (top.line < entry.line) {
              out.push({
                startLine: top.line,
                endLine: entry.line,
                kind: 'region',
              });
            }
            break;
          }
        }
      }
    }
  }
  return out;
}

function lexAllLines(text: string): Array<{tokens: Token[], line: number}> {
  const tok = new Tokenizer(text, '<lsp>', {generateDebugInfo: true});
  const lines: Array<{tokens: Token[], line: number}> = [];
  try {
    // The Tokenizer.next() resolves one line at a time.
    // We drive it synchronously by calling the protected `nextSync` via a
    // small cast. The public `next()` is async only because the Source
    // contract allows it.
    while (true) {
      const line = (tok as unknown as {nextSync(): Token[] | undefined}).nextSync();
      if (!line) break;
      const src = line.find(t => t.source)?.source;
      lines.push({tokens: line, line: (src?.line ?? 1) - 1});
    }
  } catch (_e) {
    // Stop wherever the error was. Folding is best-effort.
  }
  return lines;
}

/** Pull the first `.cs` token's `str` out of a line's tokens, if present. */
function firstCs(lineTokens: Token[]): string | undefined {
  for (const tok of lineTokens) {
    if (tok.token === 'cs') return tok.str;
  }
  return undefined;
}

/**
 * LSP semantic token type index. Keep aligned with the legend advertised on
 * `initialize` (in server.ts). For now this lives here so server.ts can just
 * forward to `SEMANTIC_TOKEN_LEGEND`.
 *
 * Everything here is a standard VS Code semantic token type, so themes colour
 * it without the client shipping its own theme. The one non-standard leftover
 * is `label`, kept because `semanticTokenScopes` in package.json maps it.
 */
export const SEMANTIC_TOKEN_LEGEND: {
  tokenTypes: string[],
  tokenModifiers: string[],
} = {
  tokenTypes: [
    'keyword',     // 0 = assembler directives
    'label',       // 1 = unresolved identifier at label position
    'variable',    // 2 = identifier in operand position, or a RAM address
    'number',      // 3 = numeric literals
    'string',      // 4 = string literals / .incbin args
    'operator',    // 5 = operators
    'comment',     // 6 = `;`-comments
    'function',    // 7 = branch/call targets, at both def and use sites
    'enumMember',  // 8 = `.enum` members
    'property',    // 9 = `.struct` members
    'namespace',   // 10 = scope qualifier in `Foo::bar`
    'macro',       // 11 = `.macro`/`.define` names and call sites
  ],
  tokenModifiers: [
    'declaration',    // 0 = the defining occurrence rather than a reference
    'readonly',       // 1 = assemble-time constant
    'static',         // 2 = cheap local (`@loop`), scoped to the enclosing label
    'defaultLibrary', // 3 = CPU mnemonic, as opposed to an assembler directive
  ],
};

// Indices into SEMANTIC_TOKEN_LEGEND.tokenTypes. These are a wire contract with
// the client, so the legend and these constants must be edited together.
const TYPE_KEYWORD = 0;
const TYPE_LABEL = 1;
const TYPE_VARIABLE = 2;
const TYPE_NUMBER = 3;
const TYPE_STRING = 4;
const TYPE_OPERATOR = 5;
const TYPE_COMMENT = 6;
const TYPE_FUNCTION = 7;
const TYPE_ENUM_MEMBER = 8;
const TYPE_PROPERTY = 9;
const TYPE_NAMESPACE = 10;
const TYPE_MACRO = 11;

// Modifier bits, as a bitmask in the 5th int of each wire tuple.
const MOD_DECLARATION = 1 << 0;
const MOD_READONLY = 1 << 1;
const MOD_STATIC = 1 << 2;
const MOD_DEFAULT_LIBRARY = 1 << 3;

export interface SymbolResolver {
  /** How `name` was declared, or undefined if the name isn't known. */
  kindOf(name: string):
      'label' | 'ramLabel' | 'constant' | 'enumMember' | 'structMember' | undefined;
  /** True if `name` names a `.macro` or `.define`. */
  isMacro(name: string): boolean;
  /** True if `name` names a `.scope` or `.proc`, so it can qualify a `::`. */
  isScope(name: string): boolean;
}

/**
 * Compute semantic tokens for a document. The LSP wire format is a flat
 * integer array of [deltaLine, deltaStart, length, type, modifiers] tuples.
 *
 * The current implementation is intentionally simple: it walks tokens line-by-
 * line and emits a token for each. Token classification is heuristic but
 * enough to give editors real syntax color.
 */
export function computeSemanticTokens(
    text: string, syms?: SymbolResolver): SemanticTokens {
  const raw: Array<{line: number, char: number, length: number, type: number, mod: number}> = [];

  const src = blankJsBlocks(text);

  // Comments never reach the token stream as `skipIgnored` consumes them, so
  // scan them straight off the text. Doing it here also means a line the
  // tokenizer chokes on still gets its comment coloured.
  collectComments(src, raw);

  const lines = src.split(/\r?\n/);
  let lineStart = 0; // next source line (0-based) the lexer should resume from
  while (lineStart < lines.length) {
    const chunk = lines.slice(lineStart).join('\n');
    const tok = new Tokenizer(chunk, '<lsp>', {generateDebugInfo: true});
    let lastLine = lineStart;
    try {
      while (true) {
        const line = (tok as unknown as {nextSync(): Token[] | undefined}).nextSync();
        if (!line) { lineStart = lines.length; break; }
        const src = line.find(t => t.source)?.source;
        if (src) lastLine = lineStart + src.line - 1;
        collectLine(line, lineStart, raw, syms);
      }
    } catch (_e) {
      // A half-typed line throws. Resume on the line *after* it rather than
      // returning: everything below a broken line would otherwise lose colour,
      // which is exactly what this module is supposed to survive.
      lineStart = lastLine + 1;
      continue;
    }
  }

  // The wire format is delta-encoded against the previous token, so the list
  // has to be in document order as comments were collected out of band.
  raw.sort((a, b) => a.line - b.line || a.char - b.char);

  const data: number[] = [];
  let prevLine = 0;
  let prevChar = 0;
  for (const t of raw) {
    const deltaLine = t.line - prevLine;
    const deltaChar = deltaLine === 0 ? t.char - prevChar : t.char;
    data.push(deltaLine, deltaChar, t.length, t.type, t.mod);
    prevLine = t.line;
    prevChar = t.char;
  }
  return {data};
}

/** Emit one logical line's tokens, recursing into curly groups. */
function collectLine(
    tokens: Token[],
    lineOffset: number,
    out: Array<{line: number, char: number, length: number, type: number, mod: number}>,
    syms?: SymbolResolver,
    depth = 0): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.token === 'grp') {
      // A `grp` is a synthetic wrapper around a `{...}` group. Emitting it as a
      // length-1 token swallowed everything nested inside it; recurse instead.
      collectLine(t.inner, lineOffset, out, syms, depth + 1);
      continue;
    }
    const src = t.source;
    if (!src) continue;
    const length = src.endColumn != null && src.endLine === src.line
        ? Math.max(1, src.endColumn - src.column)
        : tokenLength(t);
    // A leading identifier at column 0 is a label, not an operand.
    const {type, mod} = depth === 0 && i === 0
        ? classifyFirstToken(t, syms, tokens[i + 1])
        : classifyToken(t, syms, tokens[i - 1], tokens[i + 1]);
    out.push({
      line: lineOffset + src.line - 1,
      char: src.column,
      length,
      type,
      mod,
    });
  }
}

/** Find `;`-comments, which the tokenizer discards before they become tokens. */
function collectComments(
    text: string,
    out: Array<{line: number, char: number, length: number, type: number, mod: number}>): void {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Only count a `;` that isn't inside a string literal.
    let inStr: string | undefined;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (inStr) {
        if (ch === '\\') c++;
        else if (ch === inStr) inStr = undefined;
      } else if (ch === '"' || ch === '\'') {
        inStr = ch;
      } else if (ch === ';') {
        out.push({line: i, char: c, length: line.length - c, type: TYPE_COMMENT, mod: 0});
        break;
      }
    }
  }
}

/** Best-effort length when endColumn isn't populated. */
function tokenLength(t: Token): number {
  switch (t.token) {
    case 'num': return String(t.num).length;
    case 'ident': case 'op': case 'cs': case 'str': return t.str.length;
    case 'grp': return 1; // don't flatten
    default: return 1;
  }
}

interface Classified {
  type: number;
  mod: number;
}

function classifyToken(t: Token, syms: SymbolResolver | undefined,
                       prev?: Token, next?: Token): Classified {
  switch (t.token) {
    case 'cs': return classifyDirective(t.str);
    case 'num': return {type: TYPE_NUMBER, mod: 0};
    case 'str': return {type: TYPE_STRING, mod: 0};
    case 'op': return {type: TYPE_OPERATOR, mod: 0};
    case 'ident': return classifyIdent(t.str, syms, prev, next);
    default: return {type: TYPE_VARIABLE, mod: 0};
  }
}

function classifyDirective(str: string): Classified {
  const bare = str.startsWith('.') ? str.slice(1) : str;
  if (Object.hasOwn(Cpu.P02.table, bare.toLowerCase())) {
    return {type: TYPE_KEYWORD, mod: MOD_DEFAULT_LIBRARY};
  }
  return {type: TYPE_KEYWORD, mod: 0};
}

/** Classify a bare identifier using the resolver, falling back to lexical cues. */
function classifyIdent(name: string, syms: SymbolResolver | undefined,
                       prev?: Token, next?: Token): Classified {
  // A mnemonic anywhere is a mnemonic; nothing else can shadow the CPU table.
  if (Object.hasOwn(Cpu.P02.table, name.toLowerCase())) {
    return {type: TYPE_KEYWORD, mod: MOD_DEFAULT_LIBRARY};
  }
  // `Foo::bar` - the token before a `::` names a scope, not a value.
  if (isScopeOp(next)) return {type: TYPE_NAMESPACE, mod: 0};

  const cheap = name.startsWith('@');
  // The trailing segment of a qualified name resolves under its own simple
  // name, since the index keys each scope's symbols unqualified.
  const kind = syms?.kindOf(name);

  if (syms?.isMacro(name)) return {type: TYPE_MACRO, mod: 0};
  if (kind === 'enumMember') return {type: TYPE_ENUM_MEMBER, mod: MOD_READONLY};
  if (kind === 'structMember') return {type: TYPE_PROPERTY, mod: MOD_READONLY};
  // A label in a bss segment is storage, so it reads as a variable even though
  // the assembler declared it exactly the way a jump target is declared.
  if (kind === 'ramLabel') return {type: TYPE_VARIABLE, mod: 0};
  if (kind === 'label') {
    return {type: TYPE_FUNCTION, mod: cheap ? MOD_STATIC : 0};
  }
  if (kind === 'constant') return {type: TYPE_VARIABLE, mod: MOD_READONLY};
  // A scope name used as a value (`.sizeof(Foo)`) still reads as a container.
  if (syms?.isScope(name)) return {type: TYPE_NAMESPACE, mod: 0};

  // Unresolved: a cheap local is still recognisably a branch target from its
  // spelling alone, which is worth colouring before the first assemble lands.
  if (cheap) return {type: TYPE_FUNCTION, mod: MOD_STATIC};
  return {type: TYPE_VARIABLE, mod: 0};
}

/** True if the token is the `::` scope-resolution operator. */
function isScopeOp(t?: Token): boolean {
  return t?.token === 'op' && t.str === '::';
}

function classifyFirstToken(t: Token, syms: SymbolResolver | undefined,
                            next?: Token): Classified {
  if (t.token !== 'ident') return classifyToken(t, syms, undefined, next);
  if (Object.hasOwn(Cpu.P02.table, t.str.toLowerCase())) {
    return {type: TYPE_KEYWORD, mod: MOD_DEFAULT_LIBRARY};
  }
  // A leading identifier followed by `::` is still a scope qualifier, not a
  // definition: `Foo::bar = 1` assigns through the scope.
  if (isScopeOp(next)) return {type: TYPE_NAMESPACE, mod: 0};
  // A macro invocation with no label in front of it also opens a line, so a
  // known macro name here is a call and not a definition.
  if (syms?.isMacro(t.str)) return {type: TYPE_MACRO, mod: 0};

  const cheap = t.str.startsWith('@');
  const kind = syms?.kindOf(t.str);
  if (kind === 'enumMember') {
    return {type: TYPE_ENUM_MEMBER, mod: MOD_READONLY | MOD_DECLARATION};
  }
  if (kind === 'structMember') {
    return {type: TYPE_PROPERTY, mod: MOD_READONLY | MOD_DECLARATION};
  }
  // A constant defined at column 0 (`Foo = 5`) is a declaration but not a
  // branch target, so it must not take the function colour.
  if (kind === 'constant') {
    return {type: TYPE_VARIABLE, mod: MOD_READONLY | MOD_DECLARATION};
  }
  // Likewise a `Var: .res 2` in a bss segment declares storage, not a target.
  if (kind === 'ramLabel') {
    return {type: TYPE_VARIABLE, mod: MOD_DECLARATION};
  }
  if (kind === 'label' || syms) {
    return {type: TYPE_FUNCTION, mod: MOD_DECLARATION | (cheap ? MOD_STATIC : 0)};
  }
  // No resolver yet, so fall back to the pre-analysis `label` type.
  return {type: TYPE_LABEL, mod: MOD_DECLARATION | (cheap ? MOD_STATIC : 0)};
}
