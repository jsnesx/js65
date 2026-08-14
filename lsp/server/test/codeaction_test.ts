// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';

import type {CodeActionParams, Diagnostic, TextEdit} from 'vscode-languageserver-protocol';

import {computeCodeActions} from '../features/codeactions.ts';
import {Analyzer, type AnalysisResult} from '../analyzer.ts';
import {MemFs} from './memfs.ts';
import {pathToUri} from '../convert.ts';

/** Run the analyzer over a single standalone document. */
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

/** Assemble `text` and hand every diagnostic it produced to the handler. */
async function actionsFor(text: string, path = '/proj/main.s') {
  const result = await analyzeOne(new MemFs(), path, text);
  const uri = pathToUri(path);
  const diagnostics = result.diagnostics.get(uri) ?? [];
  const params: CodeActionParams = {
    textDocument: {uri},
    // The whole-document range: the client filters by cursor position, but the
    // handler answers off `context.diagnostics` alone.
    range: {start: {line: 0, character: 0}, end: {line: 1e6, character: 0}},
    context: {diagnostics},
  };
  return {diagnostics, actions: computeCodeActions(params), uri};
}

/** Apply a URI's edits to `text`, last edit first so offsets stay valid. */
function applyEdits(text: string, edits: TextEdit[]): string {
  const lines = text.split('\n');
  const offsetOf = (line: number, character: number) => {
    let offset = 0;
    for (let i = 0; i < line && i < lines.length; i++) offset += lines[i].length + 1;
    return offset + character;
  };
  const sorted = [...edits].sort(
      (a, b) => offsetOf(b.range.start.line, b.range.start.character) -
                offsetOf(a.range.start.line, a.range.start.character));
  let out = text;
  for (const e of sorted) {
    out = out.slice(0, offsetOf(e.range.start.line, e.range.start.character)) + e.newText +
        out.slice(offsetOf(e.range.end.line, e.range.end.character));
  }
  return out;
}

/** The one diagnostic carrying the given lint code. */
function withCode(diagnostics: Diagnostic[], code: string): Diagnostic {
  const found = diagnostics.filter(d => d.code === code);
  expect(found.length).toBe(1);
  return found[0];
}

describe('code actions', () => {
  it('puts the lint code and fix payload on the diagnostic', async () => {
    const text = 'main:\n  jsr sub\n  rts\nsub:\n  rts\n';
    const {diagnostics} = await actionsFor(text);
    const diag = withCode(diagnostics, 'jsr-rts-tail-call');
    expect(diag.severity).toBe(3); // info
    expect(diag.data).toBeDefined();
    expect((diag.data as {edits: unknown[]}).edits.length).toBe(2);
  });

  it('offers a quick fix that rewrites jsr/rts into a jmp', async () => {
    const text = 'main:\n  jsr sub\n  rts\nsub:\n  rts\n';
    const {actions, uri} = await actionsFor(text);
    expect(actions.length).toBe(1);
    const action = actions[0];
    expect(action.kind).toBe('quickfix');
    expect(action.title).toContain('jmp sub');
    expect(action.diagnostics?.[0].code).toBe('jsr-rts-tail-call');
    const edits = action.edit!.changes![uri];
    expect(edits.length).toBe(2);
    // The `jsr` becomes `jmp` and the now-redundant `rts` line goes away.
    expect(applyEdits(text, edits)).toBe('main:\n  jmp sub\nsub:\n  rts\n');
  });

  it('offers FALLTHROUGH for a jmp to the next line', async () => {
    const text = 'main:\n  jmp next\nnext:\n  rts\n';
    const {diagnostics, actions, uri} = await actionsFor(text);
    withCode(diagnostics, 'jmp-fallthrough');
    const action = actions.find(a => a.diagnostics?.[0].code === 'jmp-fallthrough');
    expect(action).toBeDefined();
    const edits = action!.edit!.changes![uri];
    expect(applyEdits(text, edits)).toBe('main:\n  FALLTHROUGH next\nnext:\n  rts\n');
  });

  it('returns nothing for diagnostics without a fix', async () => {
    // A bare-number operand warns but has no machine-applicable fix.
    const {diagnostics, actions} = await actionsFor('main:\n  lda 5\n  rts\n');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every(d => d.data === undefined)).toBe(true);
    expect(actions).toEqual([]);
  });

  it('ignores a data payload that is not a fix', () => {
    const params: CodeActionParams = {
      textDocument: {uri: 'file:///proj/main.s'},
      range: {start: {line: 0, character: 0}, end: {line: 0, character: 0}},
      context: {
        diagnostics: [
          {range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}},
           message: 'no data'},
          {range: {start: {line: 0, character: 0}, end: {line: 0, character: 1}},
           message: 'junk data', data: {title: 'x'}},
        ],
      },
    };
    expect(computeCodeActions(params)).toEqual([]);
  });
});
