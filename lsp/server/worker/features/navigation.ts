// SPDX-License-Identifier: MPL-2.0

import type {
  Definition,
  DefinitionParams,
  DocumentSymbol,
  Location,
  ReferenceParams,
  TextDocumentPositionParams,
  WorkspaceSymbolParams,
  SymbolInformation,
} from 'vscode-languageserver-protocol';
import {SymbolKind} from 'vscode-languageserver-protocol';

import type {Analyzer, ProjectAnalysis} from '../analyzer.ts';
import type {Symbol} from '../../../../src/assembler.ts';
import type {Token} from '../../../../src/token.ts';
import {Tokenizer} from '../../../../src/tokenizer.ts';
import {dirOf, joinDir} from '../../../../src/util.ts';
import {sourceInfoToLocation, sourceInfoToRange, rangeContains, pathToUri,
        uriToPath} from '../../convert.ts';
import {toPosix} from '../../project.ts';

export function computeDefinition(analyzer: Analyzer, p: DefinitionParams): Definition {
  const analysis = projectForDoc(analyzer, p.textDocument.uri);
  if (!analysis) return [];
  const pos = p.position;
  // Try `.include`/`.incbin` literal first since it has a different resolution
  // path than ordinary symbols.
  const includeTarget =
      resolveIncludeTarget(analysis, p, analyzer.peekDoc(p.textDocument.uri));
  if (includeTarget) {
    const loc: Location = {
      uri: pathToUri(includeTarget),
      range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}},
    };
    return loc;
  }
  const sym = findSymbolAt(analysis, p.textDocument.uri, pos.line, pos.character);
  if (!sym?.def) return [];
  return sourceInfoToLocation(sym.def, pathToUri);
}

export function computeReferences(analyzer: Analyzer, p: ReferenceParams): Location[] {
  const analysis = projectForDoc(analyzer, p.textDocument.uri);
  if (!analysis) return [];
  const sym = findSymbolAt(analysis, p.textDocument.uri, p.position.line, p.position.character);
  if (!sym) return [];
  // The definition site is recorded in both `def` and `refs`.
  // `assignSymbol` resolves the name it is defining, which counts as a reference.
  // Dedupe by location so the declaration isn't listed twice, and so that
  // dropping it for `includeDeclaration: false` actually drops it.
  const out: Location[] = [];
  const seen = new Set<string>();
  const defKey = sym.def ? locationKey(sourceInfoToLocation(sym.def, pathToUri)) : undefined;
  const push = (loc: Location) => {
    const key = locationKey(loc);
    if (seen.has(key)) return;
    if (!p.context.includeDeclaration && key === defKey) return;
    seen.add(key);
    out.push(loc);
  };
  if (p.context.includeDeclaration && sym.def) {
    push(sourceInfoToLocation(sym.def, pathToUri));
  }
  for (const ref of sym.refs ?? []) {
    push(sourceInfoToLocation(ref, pathToUri));
  }
  return out;
}

export function computeDocumentSymbols(analyzer: Analyzer,
                                       p: TextDocumentPositionParams | {textDocument: {uri: string}},
                                      ): DocumentSymbol[] {
  const analysis = projectForDoc(analyzer, p.textDocument.uri);
  if (!analysis) return [];
  const file = toPosix(uriToPath(p.textDocument.uri));
  return symbolsForFileInProject(analysis, file);
}

export function computeWorkspaceSymbols(analyzer: Analyzer,
                                        p: WorkspaceSymbolParams): SymbolInformation[] {
  const out: SymbolInformation[] = [];
  const query = p.query.toLowerCase();
  for (const analysis of analyzer.getResult()?.projects.values() ?? []) {
    for (const scope of analysis.index.walk()) {
      for (const [name, sym] of scope.symbols) {
        if (query && !name.toLowerCase().includes(query)) continue;
        const def = sym.def;
        if (!def) continue;
        out.push({
          name,
          // A symbol may exist in one project and not another because of
          // conditional assembly; tag the container so callers see which.
          containerName: `${analysis.project.name}::${scope.qualifiedName || '<root>'}`,
          kind: SymbolKind.Variable,
          location: sourceInfoToLocation(def, pathToUri),
        });
      }
    }
  }
  return out;
}

/** Identity of a location, for deduping reference lists. */
function locationKey(loc: Location): string {
  const {start, end} = loc.range;
  return `${loc.uri}\0${start.line}:${start.character}\0${end.line}:${end.character}`;
}

/**
 * Find the project the LSP request is targeting. If the URI is part of a
 * multi-project workspace, prefer the project whose touched files include it; if
 * none, fall back to the first available so editing an unrelated file still
 * works (e.g. a header file included by several projects).
 */
function projectForDoc(analyzer: Analyzer, uri: string): ProjectAnalysis | undefined {
  const result = analyzer.getResult();
  if (!result) return undefined;
  const file = toPosix(uriToPath(uri));
  let fallback: ProjectAnalysis | undefined;
  for (const analysis of result.projects.values()) {
    if (!fallback) fallback = analysis;
    if (analysis.touchedFiles.has(file)) return analysis;
  }
  return fallback;
}

/**
 * Scan the index for any symbol whose def or any ref range contains the given
 * (0-based line, 0-based character) position. Returns the live `Symbol` so
 * callers can read both `def` and `refs`.
 *
 * Cheap because the index has thousands of symbols at most, and we early-exit
 * on first match. If multiple symbols legitimately overlap (only when
 * one identifier shadows another through scope), the innermost scope wins
 * because the index walks depth-first.
 */
function findSymbolAt(analysis: ProjectAnalysis, uri: string, line: number, character: number):
    Symbol | undefined {
  const file = toPosix(uriToPath(uri));
  const pos = {line, character};
  for (const scope of analysis.index.walk()) {
    for (const sym of scope.symbols.values()) {
      if (sym.def && sym.def.file === file &&
          rangeContains(sourceInfoToRange(sym.def), pos)) return sym;
      if (sym.refs) {
        for (const ref of sym.refs) {
          if (ref.file === file && rangeContains(sourceInfoToRange(ref), pos)) return sym;
        }
      }
    }
  }
  return undefined;
}

/**
 * Build a `DocumentSymbol` tree for one file from the project's index. Only the
 * scopes that started in this file (and their direct symbols) are emitted.
 */
function symbolsForFileInProject(analysis: ProjectAnalysis, file: string): DocumentSymbol[] {
  const out: DocumentSymbol[] = [];
  for (const scope of analysis.index.walk()) {
    // Only show scopes whose opening directive lives in this file. Anonymous
    // scopes and scopes from other files (via `.include`) are skipped since they
    // belong in their own document's outline.
    if (!scope.start || scope.start.file !== file) continue;
    const range = scope.end
        ? sourceInfoToRange({...scope.start, endLine: scope.end.line, endColumn: scope.end.column})
        : sourceInfoToRange(scope.start);
    out.push({
      name: scope.name || (scope.kind === 'proc' ? '<proc>' : '<scope>'),
      detail: scope.qualifiedName,
      kind: scope.kind === 'proc' ? SymbolKind.Function : SymbolKind.Namespace,
      range,
      selectionRange: sourceInfoToRange(scope.start),
      children: childSymbolsOf(scope, file),
    });
  }
  return out;
}

/** One scope's direct symbols, as `DocumentSymbol` children. */
function childSymbolsOf(scope: {symbols: Map<string, Symbol>}, file: string): DocumentSymbol[] {
  const out: DocumentSymbol[] = [];
  for (const [name, sym] of scope.symbols) {
    if (!sym.def || sym.def.file !== file) continue;
    out.push({
      name,
      kind: SymbolKind.Variable,
      range: sourceInfoToRange(sym.def),
      selectionRange: sourceInfoToRange(sym.def),
    });
  }
  return out;
}

/**
 * Resolve an `.include` / `.incbin` string under the cursor to its target path.
 *
 * The cursor's line is re-lexed to find the `str` token the cursor sits in,
 * then resolved in `TokenStream.loadFile` order: the including file's own
 * directory first, then the project's include paths. Each candidate is validated
 * against `analysis.touchedFiles` which is an authoritative record of what the last real
 * assemble actually opened so the answer can never disagree with the build.
 */
function resolveIncludeTarget(analysis: ProjectAnalysis, p: DefinitionParams,
                              text: string | undefined): string | undefined {
  if (text == null) return undefined;
  const line = text.split(/\r?\n/)[p.position.line];
  if (line == null) return undefined;

  let tokens: Token[] | undefined;
  try {
    const tok = new Tokenizer(line, '<lsp>', {generateDebugInfo: true});
    tokens = (tok as unknown as {nextSync(): Token[] | undefined}).nextSync();
  } catch {
    return undefined; // half-typed line; nothing to resolve
  }
  if (!tokens?.length) return undefined;

  // Only `.include` / `.incbin` take a path argument.
  const first = tokens[0];
  if (first.token !== 'cs') return undefined;
  const directive = first.str.toLowerCase();
  if (directive !== '.include' && directive !== '.incbin') return undefined;

  // Find the string literal the cursor is inside. Only this one line was
  // lexed, so its tokens are all on line 0 of their own coordinate system.
  // Comparing against the document-relative cursor line would only ever match
  // an `.include` that happens to be the first line of the file.
  const cursorInLine = {line: 0, character: p.position.character};
  const target = tokens.find(t =>
      t.token === 'str' && t.source != null &&
      rangeContains(sourceInfoToRange(t.source), cursorInLine));
  if (!target || target.token !== 'str') return undefined;

  const rel = toPosix(target.str);
  // Absolute paths bypass the search order entirely.
  if (rel.startsWith('/')) {
    return analysis.touchedFiles.has(rel) ? rel : undefined;
  }

  const file = toPosix(uriToPath(p.textDocument.uri));
  const searchDirs = [dirOf(file),
                      ...(directive === '.incbin'
                          ? analysis.project.binIncludePaths
                          : analysis.project.includePaths)];
  for (const dir of searchDirs) {
    const candidate = joinDir(toPosix(dir), rel);
    if (analysis.touchedFiles.has(candidate)) return candidate;
  }
  return undefined;
}

// Re-export for tests and for the sibling feature modules that share them.
export {findSymbolAt, symbolsForFileInProject, projectForDoc};
export const __internals = {resolveIncludeTarget, childSymbolsOf};
