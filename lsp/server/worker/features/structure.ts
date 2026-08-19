// SPDX-License-Identifier: MPL-2.0

import type {FoldingRange, SemanticTokens} from 'vscode-languageserver-protocol';
import {Tokenizer} from '../../../../src/tokenizer.ts';

import type {Token} from '../../../../src/token.ts';
import {Cpu} from '../../../../src/cpu.ts';

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
 */
export const SEMANTIC_TOKEN_LEGEND: {
  tokenTypes: string[],
  tokenModifiers: string[],
} = {
  tokenTypes: [
    'keyword',     // 0 = directives and CPU mnemonics
    'label',       // 1 = identifiers at label position (column 0)
    'variable',    // 2 = identifiers in operand position
    'number',      // 3 = numeric literals
    'string',      // 4 = string literals / .incbin args
    'operator',    // 5 = operators
    'comment',     // 6 = `;`-comments
  ],
  tokenModifiers: [],
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

/**
 * Compute semantic tokens for a document. The LSP wire format is a flat
 * integer array of [deltaLine, deltaStart, length, type, modifiers] tuples.
 *
 * The current implementation is intentionally simple: it walks tokens line-by-
 * line and emits a token for each. Token classification is heuristic but
 * enough to give editors real syntax color.
 */
export function computeSemanticTokens(text: string): SemanticTokens {
  const raw: Array<{line: number, char: number, length: number, type: number}> = [];

  // Comments never reach the token stream as `skipIgnored` consumes them, so
  // scan them straight off the text. Doing it here also means a line the
  // tokenizer chokes on still gets its comment coloured.
  collectComments(text, raw);

  const lines = text.split(/\r?\n/);
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
        collectLine(line, lineStart, raw);
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
    data.push(deltaLine, deltaChar, t.length, t.type, 0);
    prevLine = t.line;
    prevChar = t.char;
  }
  return {data};
}

/** Emit one logical line's tokens, recursing into curly groups. */
function collectLine(
    tokens: Token[],
    lineOffset: number,
    out: Array<{line: number, char: number, length: number, type: number}>,
    depth = 0): void {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.token === 'grp') {
      // A `grp` is a synthetic wrapper around a `{...}` group. Emitting it as a
      // length-1 token swallowed everything nested inside it; recurse instead.
      collectLine(t.inner, lineOffset, out, depth + 1);
      continue;
    }
    const src = t.source;
    if (!src) continue;
    const length = src.endColumn != null && src.endLine === src.line
        ? Math.max(1, src.endColumn - src.column)
        : tokenLength(t);
    out.push({
      line: lineOffset + src.line - 1,
      char: src.column,
      length,
      // A leading identifier at column 0 is a label, not an operand.
      type: depth === 0 && i === 0 ? classifyFirstToken(t) : classifyToken(t),
    });
  }
}

/** Find `;`-comments, which the tokenizer discards before they become tokens. */
function collectComments(
    text: string,
    out: Array<{line: number, char: number, length: number, type: number}>): void {
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
        out.push({line: i, char: c, length: line.length - c, type: TYPE_COMMENT});
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



/** Map a Token to a SEMANTIC_TOKEN_LEGEND index. */
function classifyToken(t: Token): number {
  switch (t.token) {
    case 'cs': return TYPE_KEYWORD; // directive
    case 'num': return TYPE_NUMBER;
    case 'str': return TYPE_STRING;
    case 'op': return TYPE_OPERATOR;
    case 'ident': return TYPE_VARIABLE; // operand position
    case 'grp': return TYPE_VARIABLE;
    default: return TYPE_VARIABLE;
  }
}

/**
 * Classify the token that opens a logical line. An identifier here sits at
 * label position like `main:` and a mnemonic is a keyword rather than a
 * variable. Everything else falls through to the ordinary classification.
 */
function classifyFirstToken(t: Token): number {
  if (t.token !== 'ident') return classifyToken(t);
  return Object.hasOwn(Cpu.P02.table, t.str.toLowerCase())
      ? TYPE_KEYWORD
      : TYPE_LABEL;
}
