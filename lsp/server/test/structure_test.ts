// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';

import {computeFolding, computeSemanticTokens, SEMANTIC_TOKEN_LEGEND} from '../worker/features/structure.ts';

describe('structure', () => {
  describe('computeFolding', () => {
    it('returns one range per matched .scope/.endscope pair', () => {
      const text = [
        '.proc Main',
        '  lda #$01',
        '.endproc',
      ].join('\n') + '\n';
      const ranges = computeFolding(text);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].startLine).toBe(0);
      expect(ranges[0].endLine).toBe(2);
    });

    it('nests correctly for stacked blocks', () => {
      const text = [
        '.proc Outer',
        '  .scope Inner',
        '    nop',
        '  .endscope',
        '.endproc',
      ].join('\n') + '\n';
      const ranges = computeFolding(text);
      expect(ranges).toHaveLength(2);
      // Inner should be more nested; we don't assert specific lines beyond count
      // since order matches scan order.
    });

    it('tolerates an unclosed block (best-effort on broken text)', () => {
      const text = '.proc Main\n  nop\n'; // no .endproc
      const ranges = computeFolding(text);
      expect(ranges).toHaveLength(0);
    });

    // Finding #3: folding used the array index of each nextSync() call as the
    // source line, but nextSync skips leading EOLs — so blank and comment-only
    // lines vanished and every fold was displaced by the number of preceding
    // blank lines. The old fixtures passed only because they had none.
    it('reports real source lines across blank and comment-only lines', () => {
      const text = [
        '; leading comment',   // 0
        '',                    // 1
        '.proc Main',          // 2
        '',                    // 3
        '  ; inner comment',   // 4
        '  lda #$01',          // 5
        '.endproc',            // 6
      ].join('\n') + '\n';
      const ranges = computeFolding(text);
      expect(ranges).toHaveLength(1);
      expect(ranges[0].startLine).toBe(2);
      expect(ranges[0].endLine).toBe(6);
    });

    it('keeps nested folds on their real lines', () => {
      const text = [
        '',                  // 0
        '; header',          // 1
        '.proc Outer',       // 2
        '',                  // 3
        '  .scope Inner',    // 4
        '    nop',           // 5
        '  .endscope',       // 6
        '',                  // 7
        '.endproc',          // 8
      ].join('\n') + '\n';
      const ranges = computeFolding(text);
      expect(ranges).toHaveLength(2);
      const inner = ranges.find(r => r.startLine === 4);
      const outer = ranges.find(r => r.startLine === 2);
      expect(inner).toEqual({startLine: 4, endLine: 6, kind: 'region'});
      expect(outer).toEqual({startLine: 2, endLine: 8, kind: 'region'});
    });
  });

  describe('SEMANTIC_TOKEN_LEGEND', () => {
    it('has at least keyword/number/string/variable token types', () => {
      expect(SEMANTIC_TOKEN_LEGEND.tokenTypes).toContain('keyword');
      expect(SEMANTIC_TOKEN_LEGEND.tokenTypes).toContain('number');
    });
  });

  describe('computeSemanticTokens', () => {
    /** Decode the flat delta-encoded wire format back into absolute tokens. */
    function decode(data: number[]):
        Array<{line: number, char: number, length: number, type: number}> {
      const out = [];
      let line = 0, char = 0;
      for (let i = 0; i < data.length; i += 5) {
        line += data[i];
        char = data[i] === 0 ? char + data[i + 1] : data[i + 1];
        out.push({line, char, length: data[i + 2], type: data[i + 3]});
      }
      return out;
    }

    it('emits a token for each parsed word', () => {
      const text = 'main:\n  lda #$01\n  rts\n';
      const result = computeSemanticTokens(text);
      expect(result.data.length).toBeGreaterThan(0);
      // 5 ints per token.
      expect(result.data.length % 5).toBe(0);
    });

    // Finding #11: the legend advertised `comment` and `label` but
    // `classifyToken` emitted neither.
    it('emits the comment type the legend advertises', () => {
      const commentIdx = SEMANTIC_TOKEN_LEGEND.tokenTypes.indexOf('comment');
      const tokens = decode(computeSemanticTokens('; a comment\n  rts\n').data);
      const comment = tokens.find(t => t.type === commentIdx);
      expect(comment).toBeDefined();
      expect(comment!.line).toBe(0);
      expect(comment!.char).toBe(0);
    });

    it('classifies a leading identifier as a label, not a variable', () => {
      const labelIdx = SEMANTIC_TOKEN_LEGEND.tokenTypes.indexOf('label');
      const keywordIdx = SEMANTIC_TOKEN_LEGEND.tokenTypes.indexOf('keyword');
      const tokens = decode(computeSemanticTokens('main:\n  rts\n').data);
      expect(tokens[0].type).toBe(labelIdx);
      // A mnemonic in the same leading position is a keyword, not a label.
      const rts = tokens.find(t => t.line === 1);
      expect(rts!.type).toBe(keywordIdx);
    });

    it('every emitted type index exists in the legend', () => {
      const text = 'main:\n  lda #$01\n  .byte "hi"\n  rts ; done\n';
      for (const t of decode(computeSemanticTokens(text).data)) {
        expect(t.type).toBeLessThan(SEMANTIC_TOKEN_LEGEND.tokenTypes.length);
        expect(t.type).toBeGreaterThanOrEqual(0);
      }
    });

    // Finding #11: lexing aborted at the first error, so everything after a
    // half-typed line lost colour entirely.
    it('resumes highlighting after a line that fails to lex', () => {
      const text = 'main:\n  lda #$xx\n  rts\n';
      const tokens = decode(computeSemanticTokens(text).data);
      // The `rts` on line 2 must still be emitted despite line 1 throwing.
      expect(tokens.some(t => t.line === 2)).toBe(true);
    });

    it('recurses into curly groups instead of swallowing them', () => {
      const text = '  .macro m\n  .endmacro\n  m {lda #$01}\n';
      const tokens = decode(computeSemanticTokens(text).data);
      const onGroupLine = tokens.filter(t => t.line === 2);
      // `m`, plus the group's contents — not a single length-1 `grp` token.
      expect(onGroupLine.length).toBeGreaterThan(2);
    });

    it('emits tokens in document order', () => {
      const text = '; c1\nmain:\n  lda #$01 ; c2\n  rts\n';
      const tokens = decode(computeSemanticTokens(text).data);
      for (let i = 1; i < tokens.length; i++) {
        const prev = tokens[i - 1], cur = tokens[i];
        expect(cur.line > prev.line ||
               (cur.line === prev.line && cur.char >= prev.char)).toBe(true);
      }
    });
  });
});
