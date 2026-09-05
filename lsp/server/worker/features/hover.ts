// SPDX-License-Identifier: MPL-2.0

import type {Hover, HoverParams, MarkupContent} from 'vscode-languageserver-protocol';
import {MarkupKind} from 'vscode-languageserver-protocol';

import {Cpu} from '../../../../src/cpu.ts';
import {Macro} from '../../../../src/macro.ts';
import {Tokenizer} from '../../../../src/tokenizer.ts';
import type {Token} from '../../../../src/token.ts';
import type {Symbol} from '../../../../src/assembler.ts';
import type {Chunk} from '../../../../src/module.ts';
import type {Analyzer, ProjectAnalysis} from '../analyzer.ts';
import {findSymbolAt, projectForDoc} from './navigation.ts';
import {inJsBlock} from './jsblocks.ts';

/** Compute the hover for a position, or null if there's nothing to show. */
export function computeHover(analyzer: Analyzer, p: HoverParams): Hover | null {
  // Dont run the hover when in a jsblock
  const doc = analyzer.peekDoc(p.textDocument.uri);
  if (doc !== undefined && inJsBlock(doc, p.position.line)) return null;

  // Pick the project that actually owns this document.
  // the first project in the map answers wrongly in any multi-project workspace.
  const analysis = projectForDoc(analyzer, p.textDocument.uri);

  // 1) Symbol so load value + scope path.
  if (analysis) {
    const sym = findSymbolAt(analysis, p.textDocument.uri, p.position.line, p.position.character);
    if (sym?.expr) {
      const lines = symbolHoverLines(analysis, sym);
      const hover: MarkupContent = {
        kind: MarkupKind.Markdown,
        // Markdown swallows single newlines, so the location lines are joined
        // with a hard break to keep them stacked as one block.
        value: lines.length ? lines.join('  \n') : '(symbol with no resolved value)',
      };
      return {contents: hover};
    }
  }

  const word = wordAtPosition(analyzer, p);
  if (!word) return null;

  // 2) Mnemonic so load addressing modes from the CPU table.
  // `Object.hasOwn`, not `in`: `in` walks the prototype chain, so hovering the
  // word `constructor` or `toString` would match.
  const lower = word.toLowerCase();
  if (Object.hasOwn(Cpu.P02.table, lower)) {
    const modes = Object.keys(Cpu.P02.table[lower as keyof typeof Cpu.P02.table]);
    const hover: MarkupContent = {
      kind: MarkupKind.Markdown,
      value: `**${lower}** 6502 mnemonic\n\n_addressing modes:_ ${modes.join(', ')}`,
    };
    return {contents: hover};
  }

  // 3) Macro / define invocation so load signature + pointer at `js65/expandMacro`.
  const entry = analysis?.macros.get(word);
  if (entry) {
    const lines: string[] = [];
    if (entry.kind === 'macro' && entry.macro instanceof Macro) {
      const params = entry.macro.params;
      lines.push(`**${word}** \`.macro\`${params.length ? ` (${params.join(', ')})` : ''}`);
    } else {
      lines.push(`**${word}** \`.define\``);
    }
    if (entry.definition) {
      lines.push(`_defined at_ \`${entry.definition.file}:${entry.definition.line}\``);
    }
    lines.push('_Run `js65/expandMacro` here to see the full expansion._');
    return {contents: {kind: MarkupKind.Markdown, value: lines.join('\n\n')}};
  }

  return null;
}

/**
 * Pull a single word out of the open document at the hover position, reading
 * the live buffer. Returns undefined if the document isn't open or there's
 * nothing word-like under the cursor.
 */
function wordAtPosition(analyzer: Analyzer, p: HoverParams): string | undefined {
  const text = analyzer.peekDoc(p.textDocument.uri);
  if (text == null) return undefined;
  const line = text.split(/\r?\n/)[p.position.line];
  if (!line) return undefined;
  // Find the identifier-ish run of chars around the cursor.
  const c = p.position.character;
  let start = c;
  while (start > 0 && /[A-Za-z0-9_.]/.test(line[start - 1])) start--;
  let end = c;
  while (end < line.length && /[A-Za-z0-9_.]/.test(line[end])) end++;
  const word = line.slice(start, end);
  return word || undefined;
}

function symbolHoverLines(analysis: ProjectAnalysis, sym: Symbol): string[] {
  const expr = sym.expr!;
  const lines: string[] = [];
  const chunk = chunkFor(analysis, sym);
  const org = expr.meta?.org;

  if (chunk && org != null && !expr.meta?.rel) {
    // Fixed-position chunk: `evaluate` already folded the org in, so `num` is
    // the absolute address, and the difference back out is how far into the
    // chunk this label sits from the `.org` site.
    lines.push(`**segment:** ${segmentNameOf(chunk)}`);
    const addr = numericValue(expr);
    if (addr != null) {
      lines.push(`**org:** $${hex(addr)}`);
      const offset = addr - org;
      if (offset !== 0) lines.push(`offset from $${hex(org)}: $${hex(offset)}`);
    } else {
      lines.push(`org: $${hex(org)}`);
    }
  } else if (chunk) {
    // Relocatable chunk: nothing but the offset is known before linking.
    lines.push(`**segment:** ${segmentNameOf(chunk)}`);
    const offset = numericValue(expr);
    if (offset != null) lines.push(`**reloc:** offset $${hex(offset)}`);
  } else {
    const num = numericValue(expr);
    // `:=` marks the symbol as a location rather than a plain constant, so
    // label the number as an address to match how it was declared.
    const label = sym.isLabel ? 'addr' : 'value';
    if (num != null) lines.push(`**${label}:** \`$${hex(num)}\` (${num})`);
    if (expr.meta?.zeropage) lines.push('**segment:** zeropage');
  }

  if (sym.export) lines.push(`**exported as:** \`${sym.export}\``);
  return lines;
}

function chunkFor(analysis: ProjectAnalysis, sym: Symbol): Chunk | undefined {
  const index = sym.expr?.meta?.chunk;
  if (index == null) return undefined;
  const moduleName = analysis.index.moduleOf(sym);
  if (moduleName == null) return undefined;
  return analysis.modules.find(m => m.name === moduleName)?.chunks?.[index];
}

function segmentNameOf(chunk: Chunk): string {
  return chunk.segments.length ? chunk.segments.join(', ') : '(none)';
}

/** Lowercase hex, with negatives as `-$xx` rather than two's complement. */
function hex(num: number): string {
  return num < 0 ? `-${(-num).toString(16)}` : num.toString(16);
}

/** Best-effort numeric extraction from a resolved Expr. */
function numericValue(expr: {op: string; num?: number}): number | undefined {
  if (expr.op === 'num' && typeof expr.num === 'number') return expr.num;
  return undefined;
}

/** Params shape for the custom `js65/expandMacro` request. */
export interface ExpandMacroParams {
  uri: string;
  position: {line: number, character: number};
}

/** Result of `js65/expandMacro`. */
export interface ExpandMacroResult {
  /** The expanded text, or empty if no macro was found at the position. */
  text: string;
  /** Whether a macro/define was identified at the cursor. */
  found: boolean;
}

/**
 * Expand the macro invocation under the cursor and render the result as text.
 */
export function expandMacroAt(analyzer: Analyzer, p: ExpandMacroParams): ExpandMacroResult {
  const analysis = projectForDoc(analyzer, p.uri);
  if (!analysis) return {text: '', found: false};
  const text = analyzer.peekDoc(p.uri);
  if (text == null) return {text: '', found: false};
  const line = text.split(/\r?\n/)[p.position.line];
  if (line == null) return {text: '', found: false};

  const word = wordAt(line, p.position.character);
  if (!word) return {text: '', found: false};
  const entry = analysis.macros.get(word);
  if (!entry) return {text: '', found: false};

  const tokens = lexLine(line);
  if (!tokens) return {text: '', found: false};
  const start = tokens.findIndex(t => t.token === 'ident' && t.str === word);
  if (start < 0) return {text: '', found: false};

  try {
    const expanded = expandOnce(entry, tokens, start);
    if (!expanded) return {text: '', found: false};
    return {text: expanded.map(renderLine).join('\n'), found: true};
  } catch (err) {
    // A macro that fails to expand (wrong arity, unresolved param) isn't a
    // server error so report it as the result so the client can show it.
    return {text: `; expansion failed: ${err instanceof Error ? err.message : String(err)}`,
            found: true};
  }
}

/** Expand a single invocation, dispatching on macro vs define. */
function expandOnce(entry: NonNullable<ReturnType<ProjectAnalysis['macros']['get']>>,
                    tokens: Token[], start: number): Token[][] | undefined {
  if (entry.macro instanceof Macro) {
    // `Macro.expand` wants the invocation starting at the macro's own ident.
    let next = 0;
    return entry.macro.expand(tokens.slice(start), {next: () => next++});
  }
  // Define expands in place, mutating a copy of the line.
  const copy = [...tokens];
  return entry.macro.expand(copy, start) != null ? [copy] : undefined;
}

/** Lex one line of text into tokens, or undefined if it doesn't lex. */
function lexLine(line: string): Token[] | undefined {
  try {
    const tok = new Tokenizer(line, '<lsp>', {generateDebugInfo: true});
    return (tok as unknown as {nextSync(): Token[] | undefined}).nextSync();
  } catch {
    return undefined;
  }
}

/** Render one expanded line of tokens back to source-ish text. */
function renderLine(tokens: Token[]): string {
  const parts: string[] = [];
  for (const t of tokens) {
    switch (t.token) {
      case 'ident': case 'cs': case 'op': parts.push(t.str); break;
      case 'str': parts.push(JSON.stringify(t.str)); break;
      case 'num': parts.push(`$${t.num.toString(16)}`); break;
      case 'grp': parts.push(`{${renderLine(t.inner)}}`); break;
      case 'lb': parts.push('['); break;
      case 'rb': parts.push(']'); break;
      case 'lp': parts.push('('); break;
      case 'rp': parts.push(')'); break;
      case 'lc': parts.push('{'); break;
      case 'rc': parts.push('}'); break;
      default: break;
    }
  }
  return parts.join(' ');
}

/** Identifier-ish run of characters around a column. */
function wordAt(line: string, c: number): string | undefined {
  let start = c;
  while (start > 0 && /[A-Za-z0-9_.]/.test(line[start - 1])) start--;
  let end = c;
  while (end < line.length && /[A-Za-z0-9_.]/.test(line[end])) end++;
  return line.slice(start, end) || undefined;
}
