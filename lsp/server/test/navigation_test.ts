// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';

import {computeDefinition, computeDocumentSymbols, computeReferences, computeWorkspaceSymbols,
        findSymbolAt, symbolsForFileInProject, __internals} from '../worker/features/navigation.ts';
import type {Location} from 'vscode-languageserver-protocol';
import {Analyzer, type AnalysisResult} from '../worker/analyzer.ts';
import {MemFs} from './memfs.ts';
import {pathToUri} from '../convert.ts';

/** Run the analyzer and return the (single) project result. */
async function analyzeOne(fs: MemFs, path: string, text: string): Promise<AnalysisResult> {
  const analyzer = new Analyzer({
    workspaceRoot: '/proj', debounceMs: 0,
    fsImpl: fs.sync as any,
  });
  let resolve!: (r: AnalysisResult) => void;
  const promise = new Promise<AnalysisResult>(r => { resolve = r; });
  analyzer.onDiagnostics = r => resolve(r);
  analyzer.open(pathToUri(path), text, 1);
  return await promise;
}

describe('navigation', () => {
  describe('findSymbolAt', () => {
    it('locates a symbol by its definition range', async () => {
      const fs = new MemFs();
      //         column:   0    5
      const text = 'main:\n  lda main\n  rts\n';
      const result = await analyzeOne(fs, '/proj/main.s', text);
      const analysis = [...result.projects.values()][0];
      // `main` is defined at line 1 col 0 (1-based). SourceInfo range:
      // start line=0 (0-based), character=0, end character=4.
      // The reference is on line 2 (`  lda main`); click there should still
      // find the symbol via its ref range.
      const sym = findSymbolAt(analysis, pathToUri('/proj/main.s'), 1, 7);
      expect(sym).toBeDefined();
      expect(sym!.def).toBeDefined();
    });
  });

  // Finding #6: resolveIncludeTarget unconditionally returned undefined after
  // `void file; void analysis; void p;`, making the `.include` branch of
  // onDefinition unreachable while the module header claimed it worked.
  describe('resolveIncludeTarget', () => {
    /** Analyze a project with a real `.include` and return analyzer + result. */
    async function withInclude() {
      const fs = new MemFs();
      const main = '.include "header.inc"\nmain:\n  rts\n';
      const header = 'HEADER_MAGIC = 1\n';
      fs.add('/proj/js65.json', JSON.stringify({
        projects: [{name: 'main', sources: ['src/main.s'], includePaths: ['inc']}],
      }));
      fs.add('/proj/src/main.s', main);
      fs.add('/proj/inc/header.inc', header);
      const analyzer = new Analyzer({
        workspaceRoot: '/proj', debounceMs: 0,
        fsImpl: fs.sync as any,
      });
      analyzer.onDiagnostics = () => {};
      const p = analyzer.discoverProject('/proj/js65.json');
      if (p) analyzer.setProject(p);
      analyzer.open(pathToUri('/proj/src/main.s'), main, 1);
      analyzer.open(pathToUri('/proj/inc/header.inc'), header, 1);
      await analyzer.settled();
      return {analyzer, main};
    }

    it('resolves an .include string to the file the assemble actually opened', async () => {
      const {analyzer, main} = await withInclude();
      const analysis = analyzer.getResult()!.projects.get('main')!;
      const target = __internals.resolveIncludeTarget(analysis, {
        textDocument: {uri: pathToUri('/proj/src/main.s')},
        position: {line: 0, character: 12}, // inside "header.inc"
      } as any, main);
      expect(target).toBe('/proj/inc/header.inc');
    });

    // Only the cursor's line is re-lexed, so its tokens live at line 0 of their
    // own coordinates. Comparing those against the document-relative cursor
    // line resolved an `.include` only when it was the first line of the file.
    it('resolves an .include that is not on the first line', async () => {
      const fs = new MemFs();
      const main = '; a comment\n\n.include "header.inc"\nmain:\n  rts\n';
      const header = 'HEADER_MAGIC = 1\n';
      fs.add('/proj/js65.json', JSON.stringify({
        projects: [{name: 'main', sources: ['src/main.s'], includePaths: ['inc']}],
      }));
      fs.add('/proj/src/main.s', main);
      fs.add('/proj/inc/header.inc', header);
      const analyzer = new Analyzer({
        workspaceRoot: '/proj', debounceMs: 0,
        fsImpl: fs.sync as any,
      });
      analyzer.onDiagnostics = () => {};
      const proj = analyzer.discoverProject('/proj/js65.json');
      if (proj) analyzer.setProject(proj);
      analyzer.open(pathToUri('/proj/src/main.s'), main, 1);
      await analyzer.settled();
      const analysis = analyzer.getResult()!.projects.get('main')!;
      const target = __internals.resolveIncludeTarget(analysis, {
        textDocument: {uri: pathToUri('/proj/src/main.s')},
        position: {line: 2, character: 12}, // inside "header.inc" on line 2
      } as any, main);
      expect(target).toBe('/proj/inc/header.inc');
    });

    it('returns undefined when the cursor is off the string literal', async () => {
      const {analyzer, main} = await withInclude();
      const analysis = analyzer.getResult()!.projects.get('main')!;
      const target = __internals.resolveIncludeTarget(analysis, {
        textDocument: {uri: pathToUri('/proj/src/main.s')},
        position: {line: 0, character: 3}, // on `.include` itself
      } as any, main);
      expect(target).toBeUndefined();
    });

    it('returns undefined on a line that is not an include', async () => {
      const {analyzer, main} = await withInclude();
      const analysis = analyzer.getResult()!.projects.get('main')!;
      const target = __internals.resolveIncludeTarget(analysis, {
        textDocument: {uri: pathToUri('/proj/src/main.s')},
        position: {line: 1, character: 1},
      } as any, main);
      expect(target).toBeUndefined();
    });

    it('returns undefined without buffer text', async () => {
      const {analyzer} = await withInclude();
      const analysis = analyzer.getResult()!.projects.get('main')!;
      const target = __internals.resolveIncludeTarget(analysis, {
        textDocument: {uri: pathToUri('/proj/src/main.s')},
        position: {line: 0, character: 12},
      } as any, undefined);
      expect(target).toBeUndefined();
    });
  });

  describe('symbolsForFileInProject', () => {
    it('emits a DocumentSymbol for a .proc block', async () => {
      const fs = new MemFs();
      const text = [
        '.proc MyProc',
        'MyLocal:',
        '  lda #$01',
        '.endproc',
      ].join('\n') + '\n';
      const result = await analyzeOne(fs, '/proj/main.s', text);
      const analysis = [...result.projects.values()][0];
      const syms = symbolsForFileInProject(analysis, '/proj/main.s');
      expect(syms.length).toBeGreaterThan(0);
      const proc = syms.find(s => s.name === 'MyProc');
      expect(proc).toBeDefined();
      expect(proc!.children?.length).toBeGreaterThan(0);
    });
  });
});

// The four compute functions the LSP handlers forward to. Before they were extracted from
// `registerNavigationFeatures` the only way to reach this logic was through a live
// `Connection`, so none of it was directly covered.
describe('navigation compute functions', () => {
  /** Analyze a two-symbol file and hand back the analyzer driving it. */
  async function analyzed(text: string, path = '/proj/main.s') {
    const fs = new MemFs();
    const analyzer = new Analyzer({
      workspaceRoot: '/proj', debounceMs: 0,
      fsImpl: fs.sync as any,
    });
    let resolve!: () => void;
    const done = new Promise<void>(r => { resolve = r; });
    analyzer.onDiagnostics = () => resolve();
    analyzer.open(pathToUri(path), text, 1);
    await done;
    return {analyzer, uri: pathToUri(path)};
  }

  const SOURCE = 'main:\n  lda main\n  rts\n';

  describe('computeDefinition', () => {
    it('resolves a reference to its definition site', async () => {
      const {analyzer, uri} = await analyzed(SOURCE);
      const def = computeDefinition(analyzer, {
        textDocument: {uri}, position: {line: 1, character: 7},
      } as any);
      expect(Array.isArray(def)).toBe(false);
      expect((def as Location).uri).toBe(uri);
      expect((def as Location).range.start.line).toBe(0);
    });

    it('returns an empty list where nothing is defined', async () => {
      const {analyzer, uri} = await analyzed(SOURCE);
      const def = computeDefinition(analyzer, {
        textDocument: {uri}, position: {line: 2, character: 3},
      } as any);
      expect(def).toEqual([]);
    });
  });

  describe('computeReferences', () => {
    it('includes the declaration when asked', async () => {
      const {analyzer, uri} = await analyzed(SOURCE);
      const refs = computeReferences(analyzer, {
        textDocument: {uri}, position: {line: 1, character: 7},
        context: {includeDeclaration: true},
      } as any);
      expect(refs.length).toBeGreaterThan(0);
      expect(refs.some(r => r.range.start.line === 0)).toBe(true);
    });

    it('drops the declaration when it is not wanted, without duplicates', async () => {
      const {analyzer, uri} = await analyzed(SOURCE);
      const refs = computeReferences(analyzer, {
        textDocument: {uri}, position: {line: 1, character: 7},
        context: {includeDeclaration: false},
      } as any);
      expect(refs.some(r => r.range.start.line === 0)).toBe(false);
      const keys = refs.map(r => `${r.uri}:${r.range.start.line}:${r.range.start.character}`);
      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('computeDocumentSymbols', () => {
    it('builds the outline for the requested document', async () => {
      const {analyzer, uri} = await analyzed(
          '.proc MyProc\nMyLocal:\n  lda #$01\n.endproc\n');
      const syms = computeDocumentSymbols(analyzer, {textDocument: {uri}});
      expect(syms.find(s => s.name === 'MyProc')).toBeDefined();
    });
  });

  describe('computeWorkspaceSymbols', () => {
    it('filters by query, case-insensitively', async () => {
      const {analyzer} = await analyzed('MainLabel:\n  rts\n');
      const all = computeWorkspaceSymbols(analyzer, {query: ''} as any);
      expect(all.some(s => s.name === 'MainLabel')).toBe(true);
      const hit = computeWorkspaceSymbols(analyzer, {query: 'mainl'} as any);
      expect(hit.some(s => s.name === 'MainLabel')).toBe(true);
      expect(computeWorkspaceSymbols(analyzer, {query: 'zzznope'} as any)).toEqual([]);
    });

    it('tags each symbol with its project and scope', async () => {
      const {analyzer} = await analyzed('MainLabel:\n  rts\n');
      const found = computeWorkspaceSymbols(analyzer, {query: 'MainLabel'} as any);
      expect(found[0].containerName).toContain('::');
    });
  });
});
