// SPDX-License-Identifier: MPL-2.0

/**
 * Compute half of completion while typing.
 *
 * Current list of completions:
 *   - After `.` (trigger char) -> directive list
 *   - At column 0 -> label position so no mnemonics and no symbols
 *   - After a mnemonic -> symbols in the cursor's scope
 *   - Otherwise -> mnemonics + in-scope symbols
 */

import type {CompletionItem, CompletionParams} from 'vscode-languageserver-protocol';
import {CompletionItemKind} from 'vscode-languageserver-protocol';

import {DIRECTIVES, TOKENFUNCS} from '../../../../src/token.ts';
import {Cpu} from '../../../../src/cpu.ts';
import type {IndexedScope} from '../../../../src/lspindex.ts';
import type {Analyzer, ProjectAnalysis} from '../analyzer.ts';
import {uriToPath} from '../../convert.ts';
import {toPosix} from '../../project.ts';
import {inJsBlock} from './jsblocks.ts';

/** Mnemonics from the CPU table, captured once. */
const MNEMONICS = Object.keys(Cpu.P02.table);

/** Where the cursor sits on its line, which decides what's worth offering. */
type Position = 'directive' | 'label' | 'operand' | 'mnemonic';

export function computeCompletion(analyzer: Analyzer, p: CompletionParams): CompletionItem[] {
  const text = analyzer.peekDoc(p.textDocument.uri);
  // Don't send the regular js65 completions in a jsblock
  if (text !== undefined && inJsBlock(text, p.position.line)) return [];
  const line = text?.split(/\r?\n/)[p.position.line];
  const where = classifyPosition(line, p.position.character,
                                 p.context?.triggerCharacter);

  if (where === 'directive') {
    // Directive position. Use both the early DIRECTIVES list and the function-
    // like TOKENFUNCS set so completion covers both statements and builtins.
    const out: CompletionItem[] = [];
    for (const d of DIRECTIVES) {
      out.push({label: d, kind: CompletionItemKind.Keyword});
    }
    for (const f of TOKENFUNCS) {
      out.push({label: f, kind: CompletionItemKind.Function});
    }
    return out;
  }

  // A label is being defined. Offering existing names or mnemonics here is
  // noise, since the user is naming something new.
  if (where === 'label') return [];

  const out: CompletionItem[] = [];

  // Mnemonics only make sense where an instruction can start, not in an operand.
  if (where === 'mnemonic') {
    for (const m of MNEMONICS) {
      out.push({label: m, kind: CompletionItemKind.Keyword});
    }
  }

  const result = analyzer.getResult();
  if (result) {
    const file = toPosix(uriToPath(p.textDocument.uri));
    let analysis: ProjectAnalysis | undefined =
        [...result.projects.values()].find(a => a.touchedFiles.has(file));
    if (!analysis) analysis = result.projects.values().next().value;
    if (analysis) {
      for (const [name, scope] of symbolsInScope(analysis, file, p.position.line)) {
        out.push({
          label: name,
          kind: CompletionItemKind.Variable,
          detail: scope ? `in ${scope}` : undefined,
        });
      }
      // Macros and defines are callable at instruction position too.
      if (where === 'mnemonic') {
        for (const macro of analysis.macros.all()) {
          out.push({
            label: macro.name,
            kind: CompletionItemKind.Function,
            detail: macro.kind === 'macro' ? '.macro' : '.define',
          });
        }
      }
    }
  }

  return out;
}

function classifyPosition(line: string | undefined, character: number,
                          trigger: string | undefined): Position {
  if (trigger === '.') return 'directive';
  if (line == null) return 'mnemonic';
  const before = line.slice(0, character);
  // A partially typed directive: `.inc|`.
  if (/\.[A-Za-z0-9]*$/.test(before)) return 'directive';
  // Column 0 (or only whitespace-free text so far) is label position in ca65.
  if (!/^\s/.test(line) && !/\s/.test(before.trimEnd()) && before.trim() !== '') {
    return 'label';
  }
  if (before.trim() === '' && !/^\s/.test(line)) return 'label';
  // First word on an indented line is the mnemonic slot; anything after it is
  // an operand.
  const words = before.trim().split(/\s+/).filter(w => w);
  const finished = /\s$/.test(before);
  if (words.length === 0 || (words.length === 1 && !finished)) return 'mnemonic';
  return 'operand';
}

function symbolsInScope(analysis: ProjectAnalysis, file: string, line: number):
    Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const seen = new Set<string>();
  const innermost = analysis.index.scopeAt(file, line + 1) ?? analysis.index.root;
  // Walk from the innermost scope outwards, so a shadowing local wins.
  for (const scope of ancestorsOf(analysis, innermost)) {
    for (const name of scope.symbols.keys()) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push([name, scope.qualifiedName]);
    }
  }
  return out;
}

/** The scope chain from `scope` up to (and including) the index root. */
function ancestorsOf(analysis: ProjectAnalysis, scope: IndexedScope): IndexedScope[] {
  // `IndexedScope` has no parent pointer, so reconstruct the chain by matching
  // qualified-name prefixes so `Foo::Bar`'s ancestors are `Foo` and the root.
  const chain: IndexedScope[] = [scope];
  const parts = scope.qualifiedName ? scope.qualifiedName.split('::') : [];
  for (let i = parts.length - 1; i > 0; i--) {
    const qualified = parts.slice(0, i).join('::');
    const found = analysis.index.findScope(qualified);
    if (found) chain.push(found);
  }
  if (scope !== analysis.index.root) chain.push(analysis.index.root);
  return chain;
}

// Re-export for tests.
export {classifyPosition};
