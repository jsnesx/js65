// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';

import {messageToDiagnostic, sourceInfoToRange, rangeContains, pathToUri, uriToPath} from '../convert.ts';
import type {AssemblerMessage, SourceInfo} from '../../../src/error.ts';

describe('convert', () => {
  describe('sourceInfoToRange', () => {
    it('converts 1-based line / 0-based column to LSP 0-based coords', () => {
      const info: SourceInfo = {file: 'a.s', line: 5, column: 3};
      const r = sourceInfoToRange(info);
      expect(r.start).toEqual({line: 4, character: 3});
      // No end position -> zero-width range at the start.
      expect(r.end).toEqual({line: 4, character: 3});
    });

    it('uses endLine/endColumn when present', () => {
      const info: SourceInfo = {file: 'a.s', line: 5, column: 3, endLine: 5, endColumn: 9};
      const r = sourceInfoToRange(info);
      expect(r.start).toEqual({line: 4, character: 3});
      expect(r.end).toEqual({line: 4, character: 9});
    });

    it('clamps negative values silently (corrupted input should not crash LSP clients)', () => {
      const info: SourceInfo = {file: 'a.s', line: 0, column: -1};
      const r = sourceInfoToRange(info);
      expect(r.start).toEqual({line: 0, character: 0});
    });
  });

  describe('messageToDiagnostic', () => {
    it('maps levels to LSP severities', () => {
      const cases: Array<[AssemblerMessage['level'], 1|2|3]> = [
        ['error', 1], ['warning', 2], ['info', 3],
      ];
      for (const [level, severity] of cases) {
        const msg: AssemblerMessage = {level, message: `test ${level}`};
        const d = messageToDiagnostic(msg, _ => 'file://x');
        expect(d.severity).toBe(severity);
      }
    });

    it('walks the parent chain into relatedInformation', () => {
      const parent: SourceInfo = {file: 'inc.s', line: 2, column: 0};
      const source: SourceInfo = {file: 'main.s', line: 4, column: 1, parent};
      const msg: AssemblerMessage = {level: 'error', message: 'boom', source};
      const d = messageToDiagnostic(msg, p => `file://${p}`);
      expect(d.relatedInformation).toHaveLength(1);
      expect(d.relatedInformation![0].message).toBe('expanded from here');
      expect(d.relatedInformation![0].location.uri).toBe('file://inc.s');
    });

    it('handles a message with no source location', () => {
      const msg: AssemblerMessage = {level: 'error', message: 'internal'};
      const d = messageToDiagnostic(msg, _ => 'file://x');
      expect(d.range).toEqual({start: {line: 0, character: 0}, end: {line: 0, character: 0}});
      expect(d.relatedInformation).toBeUndefined();
    });
  });

  describe('rangeContains', () => {
    const range = {start: {line: 0, character: 5}, end: {line: 2, character: 5}};
    it('contains a point inside', () => {
      expect(rangeContains(range, {line: 1, character: 0})).toBe(true);
    });
    it('rejects a point before start', () => {
      expect(rangeContains(range, {line: 0, character: 1})).toBe(false);
    });
    it('rejects a point at end (end is exclusive)', () => {
      expect(rangeContains(range, {line: 2, character: 5})).toBe(false);
    });
    it('rejects a point after end', () => {
      expect(rangeContains(range, {line: 3, character: 0})).toBe(false);
    });
  });

  describe('uri <-> path', () => {
    it('round-trips a POSIX path through file:// URI', () => {
      const p = '/abs/path/file.s';
      const uri = pathToUri(p);
      expect(uri.startsWith('file://')).toBe(true);
      // On non-Windows hosts, fsPath comes back POSIX.
      expect(uriToPath(uri).replace(/\\/g, '/')).toBe(p);
    });
  });
});
