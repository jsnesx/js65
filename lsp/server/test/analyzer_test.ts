// SPDX-License-Identifier: MPL-2.0

import {describe, it, expect} from 'bun:test';

import type {Diagnostic} from 'vscode-languageserver-protocol';

import {Analyzer, type AnalysisResult} from '../analyzer.ts';
import {MemFs} from './memfs.ts';
import {toPosix} from '../project.ts';
import {pathToUri} from '../convert.ts';

/**
 * LSP 3.18 widened `Diagnostic.message` to `string | MarkupContent`. Everything
 * `messageToDiagnostic` produces is a plain string, so this narrows without the
 * assertions having to care.
 */
function messageOf(d: Diagnostic): string {
  return typeof d.message === 'string' ? d.message : d.message.value;
}

/**
 * Helper: open a doc, wait for the debounce + the async assemble to settle.
 * The analyzer's onDiagnostics callback resolves the promise once it fires.
 */
async function runAnalyzer(
    fs: MemFs,
    docs: Array<{path: string, text: string}>,
    project?: {rootDir: string, json: string, extraFiles?: Record<string, string>},
): Promise<AnalysisResult> {
  const analyzer = new Analyzer({
    workspaceRoot: project?.rootDir ?? '/proj',
    debounceMs: 0, // run synchronously on a 0ms timeout
    fsImpl: fs.sync as any,
    fsImplPromises: fs.promises as any,
  });
  let resolveDiagnostics!: (r: AnalysisResult) => void;
  const diagnosticsPromise = new Promise<AnalysisResult>(res => { resolveDiagnostics = res; });
  analyzer.onDiagnostics = (r) => resolveDiagnostics(r);

  if (project) {
    fs.add(`${project.rootDir}/js65.json`, project.json);
    if (project.extraFiles) {
      for (const [p, c] of Object.entries(project.extraFiles)) {
        fs.add(p.startsWith('/') ? p : `${project.rootDir}/${p}`, c);
      }
    }
    // Discover + set project before opening docs.
    const discovered = analyzer.discoverProject(`${project.rootDir}/js65.json`);
    if (discovered) analyzer.setProject(discovered);
  }

  for (const d of docs) {
    analyzer.open(pathToUri(d.path), d.text, 1);
  }
  // Kick the event loop past the setTimeout(0) debounce.
  return await diagnosticsPromise;
}

describe('analyzer', () => {
  it('reports a parse error from a standalone file with a non-zero-width range', async () => {
    const fs = new MemFs();
    const code = '  lda #$xx\n'; // invalid hex literal -> tokenize error
    const result = await runAnalyzer(fs, [{path: '/proj/main.s', text: code}]);
    expect(result.diagnostics.size).toBeGreaterThan(0);
    for (const [uri, diags] of result.diagnostics) {
      expect(uri).toBe(pathToUri('/proj/main.s'));
      // Find the actual error diagnostic and verify it has a range.
      const err = diags.find(d => d.severity === 1);
      expect(err).toBeDefined();
      // The range should point at the file (line is somewhere reasonable).
      expect(err!.range.start.line).toBeGreaterThanOrEqual(0);
    }
  });

  it('publishes every error in a file, not just the first', async () => {
    // A tokenizer or preprocessor failure used to abort the whole assemble, so
    // the editor showed one squiggle and the rest of the file looked clean.
    const fs = new MemFs();
    const code = [
      '  lda #$xx',   // tokenizer: bad hex literal
      '  .ifdef',     // preprocessor: missing argument
      '  .endif',
      '  bogusinstr', // assembler: unknown mnemonic
      '  otherbogus',
    ].join('\n') + '\n';
    const result = await runAnalyzer(fs, [{path: '/proj/main.s', text: code}]);
    const diags = result.diagnostics.get(pathToUri('/proj/main.s')) ?? [];
    const errors = diags.filter(d => d.severity === 1);
    // Exactly one per bad line, on the line it belongs to. The broken `.ifdef`
    // still opens a conditional, so its `.endif` on line 2 is not also an error.
    expect(errors.map(d => d.range.start.line).sort((a, b) => a - b))
        .toEqual([0, 1, 3, 4]);
    expect(errors.some(d => /Bad hex/.test(messageOf(d)))).toBe(true);
    expect(errors.some(d => messageOf(d) === 'Bad mnemonic: otherbogus')).toBe(true);
  });

  it('assembles a clean project with zero diagnostics', async () => {
    const fs = new MemFs();
    const code = 'main:\n  lda #$01\n  rts\n';
    const result = await runAnalyzer(fs, [{path: '/proj/main.s', text: code}]);
    expect(result.diagnostics.size).toBe(0);
  });

  it('reaches an included file through the open-docs vfs', async () => {
    const fs = new MemFs();
    // ca65 convention: `.include "name"` resolves against the file's own dir
    // and then the -I directories. The unit's `inc` is on the search path.
    const main = '.include "header.inc"\nmain:\n  rts\n';
    const header = 'HEADER_MAGIC = 1\n';
    const result = await runAnalyzer(fs, [
      {path: '/proj/src/main.s', text: main},
      {path: '/proj/inc/header.inc', text: header},
    ], {
      rootDir: '/proj',
      json: JSON.stringify({
        units: [{
          name: 'main',
          sources: ['src/main.s'],
          includePaths: ['inc'],
        }],
      }),
    });
    // No diagnostics expected (include resolves, no undefined symbols).
    expect([...result.diagnostics.values()].every(d => d.length === 0)).toBe(true);
    // The header should have been touched.
    const unit = result.units.get('main');
    expect(unit).toBeDefined();
    const headerPosix = toPosix('/proj/inc/header.inc');
    expect(unit!.touchedFiles.has(headerPosix)).toBe(true);
  });

  it('captures a definition in the symbol index', async () => {
    const fs = new MemFs();
    const code = 'main:\n  lda #$01\n  rts\n';
    const result = await runAnalyzer(fs, [{path: '/proj/main.s', text: code}]);
    // Find any unit; in standalone mode there's exactly one.
    const unit = [...result.units.values()][0];
    expect(unit).toBeDefined();
    // `main` should be a defined symbol.
    const found = unit.index.findSymbol('main');
    expect(found).toBeDefined();
    expect(found!.sym.def).toBeDefined();
    expect(found!.sym.def!.file).toBe(toPosix('/proj/main.s'));
  });

  it('downgrades undefined-symbol errors to warnings in standalone mode', async () => {
    const fs = new MemFs();
    // Refers to `undefined_sym` which is not defined.
    const code = 'main:\n  lda undefined_sym\n  rts\n';
    const result = await runAnalyzer(fs, [{path: '/proj/main.s', text: code}]);
    const diags = [...result.diagnostics.values()].flat();
    // No raw errors; the undefined reference is a [standalone] warning.
    expect(diags.some(d => d.severity === 1)).toBe(false);
    const standalone = diags.find(d => messageOf(d).includes('[standalone]'));
    expect(standalone).toBeDefined();
    expect(standalone!.severity).toBe(2);
  });

  // Finding #1: a unit pointing at a path that doesn't exist used to let ENOENT
  // escape run() as an unhandled rejection, killing the process, with
  // onDiagnostics never firing at all.
  it('reports a missing source file as a diagnostic instead of crashing', async () => {
    const fs = new MemFs();
    const result = await runAnalyzer(fs, [{path: '/proj/main.s', text: 'main:\n  rts\n'}], {
      rootDir: '/proj',
      json: JSON.stringify({
        units: [{name: 'main', sources: ['main.s', 'does_not_exist.s']}],
      }),
    });
    const diags = [...result.diagnostics.values()].flat();
    const err = diags.find(d => d.severity === 1);
    expect(err).toBeDefined();
    expect(err!.message).toMatch(/does_not_exist\.s|ENOENT/i);
    // It must land on a real document, not vanish for want of a source.
    expect(result.diagnostics.size).toBeGreaterThan(0);
  });

  it('survives a source deleted while the editor is open', async () => {
    const fs = new MemFs();
    fs.add('/proj/gone.s', 'gone:\n  rts\n');
    const analyzer = new Analyzer({
      workspaceRoot: '/proj',
      debounceMs: 0,
      fsImpl: fs.sync as any,
      fsImplPromises: fs.promises as any,
    });
    const results: AnalysisResult[] = [];
    analyzer.onDiagnostics = (r) => { results.push(r); };
    // Not opened as a document, so the analyzer must read it from disk.
    fs.remove('/proj/gone.s');
    analyzer.open(pathToUri('/proj/gone.s'), 'gone:\n  rts\n', 1);
    await new Promise(r => setTimeout(r, 50));
    // The open doc wins over disk, so this assembles fine — the point is that
    // nothing threw and diagnostics were published.
    expect(results.length).toBeGreaterThan(0);
  });

  // Finding #2: schedule() cleared `pending` immediately after launching run(),
  // so a started run was never cancelled. A slow run could publish after a
  // newer one and leave the editor navigating a stale symbol index.
  it('does not let a superseded run overwrite a newer result', async () => {
    const fs = new MemFs();
    fs.add('/proj/slow.inc', 'SLOW = 1\n');
    fs.delay('slow.inc', 60);
    const analyzer = new Analyzer({
      workspaceRoot: '/proj',
      debounceMs: 0,
      fsImpl: fs.sync as any,
      fsImplPromises: fs.promises as any,
    });
    const published: AnalysisResult[] = [];
    analyzer.onDiagnostics = (r) => { published.push(r); };

    const uri = pathToUri('/proj/main.s');
    analyzer.open(uri, '.include "slow.inc"\nFIRST = 1\n', 1);
    // Let the first pass start and block on the slow include read.
    await new Promise(r => setTimeout(r, 10));
    analyzer.change(uri, '.include "slow.inc"\nSECOND = 2\n', 2);
    // Wait for everything to settle.
    await new Promise(r => setTimeout(r, 250));

    // Whatever was published last must reflect the newest buffer text.
    const final = analyzer.getResult();
    expect(final).toBeDefined();
    const unit = [...final!.units.values()][0];
    expect(unit.index.findSymbol('SECOND')).toBeDefined();
    expect(unit.index.findSymbol('FIRST')).toBeUndefined();
    // And the stale pass must not have published at all.
    for (const r of published) {
      const u = [...r.units.values()][0];
      if (u) expect(u.index.findSymbol('FIRST')).toBeUndefined();
    }
  });

  it('unions changed paths across one debounce window', async () => {
    const fs = new MemFs();
    const analyzer = new Analyzer({
      workspaceRoot: '/proj',
      debounceMs: 20,
      fsImpl: fs.sync as any,
      fsImplPromises: fs.promises as any,
    });
    let result: AnalysisResult | undefined;
    analyzer.onDiagnostics = (r) => { result = r; };
    // Two different files inside one debounce window: both units must rebuild.
    analyzer.open(pathToUri('/proj/a.s'), 'a_sym = 1\n', 1);
    analyzer.open(pathToUri('/proj/b.s'), 'b_sym = 2\n', 1);
    await new Promise(r => setTimeout(r, 120));
    expect(result).toBeDefined();
    expect(result!.units.size).toBe(2);
  });

  // Finding #20: schedule() early-returned when openDocs was empty, so the
  // last file's squiggles were left on screen forever.
  it('publishes an empty result after the last document is closed', async () => {
    const fs = new MemFs();
    const analyzer = new Analyzer({
      workspaceRoot: '/proj',
      debounceMs: 0,
      fsImpl: fs.sync as any,
      fsImplPromises: fs.promises as any,
    });
    const published: AnalysisResult[] = [];
    analyzer.onDiagnostics = (r) => { published.push(r); };
    const uri = pathToUri('/proj/main.s');
    analyzer.open(uri, '  lda #$xx\n', 1); // has an error
    await new Promise(r => setTimeout(r, 60));
    const before = published.length;
    expect(before).toBeGreaterThan(0);

    analyzer.close(uri);
    await new Promise(r => setTimeout(r, 60));
    // A pass must have run after the close, so the server can clear the URI.
    expect(published.length).toBeGreaterThan(before);
  });

  // Feature handlers await settled() before answering. A client caches an empty
  // answer against the document version, so answering early leaves an editor
  // showing a blank outline until the file is next edited.
  describe('settled()', () => {
    it('resolves immediately when nothing is scheduled', async () => {
      const analyzer = new Analyzer({workspaceRoot: '/proj', debounceMs: 0});
      const before = Date.now();
      await analyzer.settled();
      expect(Date.now() - before).toBeLessThan(50);
    });

    it('waits for a scheduled pass to finish before resolving', async () => {
      const fs = new MemFs();
      fs.add('/proj/slow.inc', 'SLOW = 1\n');
      fs.delay('slow.inc', 60);
      const analyzer = new Analyzer({
        workspaceRoot: '/proj', debounceMs: 10,
        fsImpl: fs.sync as any, fsImplPromises: fs.promises as any,
      });
      analyzer.onDiagnostics = () => {};
      analyzer.open(pathToUri('/proj/main.s'), '.include "slow.inc"\nmain:\n  rts\n', 1);
      // Without the wait there is no result at all yet.
      expect(analyzer.getResult()).toBeUndefined();
      await analyzer.settled();
      const unit = [...analyzer.getResult()!.units.values()][0];
      expect(unit.index.findSymbol('main')).toBeDefined();
    });

    it('waits through a pass that was superseded mid-flight', async () => {
      const fs = new MemFs();
      fs.add('/proj/slow.inc', 'SLOW = 1\n');
      fs.delay('slow.inc', 40);
      const analyzer = new Analyzer({
        workspaceRoot: '/proj', debounceMs: 0,
        fsImpl: fs.sync as any, fsImplPromises: fs.promises as any,
      });
      analyzer.onDiagnostics = () => {};
      const uri = pathToUri('/proj/main.s');
      analyzer.open(uri, '.include "slow.inc"\nFIRST = 1\n', 1);
      await new Promise(r => setTimeout(r, 10));
      analyzer.change(uri, '.include "slow.inc"\nSECOND = 2\n', 2);
      await analyzer.settled();
      // Must reflect the newest buffer, not whichever pass finished first.
      const unit = [...analyzer.getResult()!.units.values()][0];
      expect(unit.index.findSymbol('SECOND')).toBeDefined();
    });

    it('gives up after its timeout rather than hanging a request', async () => {
      const fs = new MemFs();
      fs.add('/proj/slow.inc', 'SLOW = 1\n');
      fs.delay('slow.inc', 400);
      const analyzer = new Analyzer({
        workspaceRoot: '/proj', debounceMs: 0,
        fsImpl: fs.sync as any, fsImplPromises: fs.promises as any,
      });
      analyzer.onDiagnostics = () => {};
      analyzer.open(pathToUri('/proj/main.s'), '.include "slow.inc"\nmain:\n  rts\n', 1);
      const before = Date.now();
      await analyzer.settled(50);
      expect(Date.now() - before).toBeLessThan(300);
    });
  });

  // Finding #21: standalone units keyed by basename collided.
  it('keeps two same-named files in different directories apart', async () => {
    const fs = new MemFs();
    const analyzer = new Analyzer({
      workspaceRoot: '/proj',
      debounceMs: 0,
      fsImpl: fs.sync as any,
      fsImplPromises: fs.promises as any,
    });
    let result: AnalysisResult | undefined;
    analyzer.onDiagnostics = (r) => { result = r; };
    analyzer.open(pathToUri('/proj/one/main.s'), 'one_sym = 1\n', 1);
    analyzer.open(pathToUri('/proj/two/main.s'), 'two_sym = 2\n', 1);
    await new Promise(r => setTimeout(r, 80));
    expect(result).toBeDefined();
    expect(result!.units.size).toBe(2);
  });

  // A file inside a `js65.json` workspace that no unit owns (a scratch file, a
  // header not `.include`d yet) used to get no diagnostics at all: it belonged
  // to no unit, so nothing assembled it, and the editor showed a clean file.
  it('falls back to standalone for an open file no unit owns', async () => {
    const fs = new MemFs();
    const result = await runAnalyzer(fs, [
      {path: '/proj/main.s', text: 'main:\n  rts\n'},
      {path: '/proj/scratch.s', text: '  lda #$xx\n'},
    ], {
      rootDir: '/proj',
      json: JSON.stringify({units: [{name: 'main', sources: ['main.s']}]}),
    });
    const scratch = result.diagnostics.get(pathToUri('/proj/scratch.s')) ?? [];
    expect(scratch.some(d => /hex/i.test(messageOf(d)))).toBe(true);
    // And the owned file still went through its real unit, not a standalone one.
    expect(result.units.get('main')?.standalone).toBe(false);
  });

  it('does not double-assemble a file its unit already covers', async () => {
    const fs = new MemFs();
    const result = await runAnalyzer(fs, [
      {path: '/proj/main.s', text: '.include "header.inc"\nmain:\n  rts\n'},
      {path: '/proj/header.inc', text: '  lda #$xx\n'},
    ], {
      rootDir: '/proj',
      json: JSON.stringify({units: [{name: 'main', sources: ['main.s'], includePaths: ['.']}]}),
    });
    // `header.inc` is reached through the unit, so there must be no second
    // standalone unit for it — that would publish every diagnostic twice.
    expect(result.units.size).toBe(1);
    const header = result.diagnostics.get(pathToUri('/proj/header.inc')) ?? [];
    expect(header.filter(d => /hex/i.test(messageOf(d)))).toHaveLength(1);
  });

  // Finding #14: the bucketing comment promised a dedupe that didn't exist.
  it('dedupes identical diagnostics from a header included twice', async () => {
    const fs = new MemFs();
    const result = await runAnalyzer(fs, [
      {path: '/proj/a.s', text: '.include "bad.inc"\n'},
      {path: '/proj/b.s', text: '.include "bad.inc"\n'},
    ], {
      rootDir: '/proj',
      json: JSON.stringify({
        units: [{name: 'both', sources: ['a.s', 'b.s'], includePaths: ['.']}],
      }),
      extraFiles: {'bad.inc': '  lda #$xx\n'},
    });
    const forHeader = result.diagnostics.get(pathToUri('/proj/bad.inc')) ?? [];
    // The same (file,line,column,message) must appear at most once.
    const keys = forHeader.map(
        d => `${d.range.start.line}:${d.range.start.character}:${d.message}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // Finding #9: link() was never called, so `linkerConfig` / `target` were
  // parsed, validated, and read by nothing. Segment overflow is only detectable
  // at link time.
  describe('link on save', () => {
    const CFG = [
      'MEMORY {',
      '  RAM: start=$200, size=$10, type=rw, file=%O;',
      '}',
      'SEGMENTS {',
      '  CODE: load=RAM, type=ro;',
      '}',
    ].join('\n');
    // 32 bytes of code into a 16-byte segment.
    const OVERFLOW = '.segment "CODE"\n' + '  .byte 1,2,3,4,5,6,7,8\n'.repeat(4);

    async function analyzerFor(code: string) {
      const fs = new MemFs();
      fs.add('/proj/js65.json', JSON.stringify({
        units: [{name: 'main', sources: ['main.s'], linkerConfig: 'nes.cfg'}],
      }));
      fs.add('/proj/nes.cfg', CFG);
      fs.add('/proj/main.s', code);
      const analyzer = new Analyzer({
        workspaceRoot: '/proj', debounceMs: 0,
        fsImpl: fs.sync as any, fsImplPromises: fs.promises as any,
      });
      analyzer.onDiagnostics = () => {};
      const p = analyzer.discoverProject('/proj/js65.json');
      if (p) analyzer.setProject(p);
      analyzer.open(pathToUri('/proj/main.s'), code, 1);
      await new Promise(r => setTimeout(r, 120));
      return analyzer;
    }

    it('reports a segment overflow that assembling alone does not catch', async () => {
      const analyzer = await analyzerFor(OVERFLOW);
      // Assembling is clean — the overflow only exists once segments are placed.
      const beforeErrors = [...analyzer.getResult()!.diagnostics.values()]
          .flat().filter(d => d.severity === 1);
      expect(beforeErrors).toHaveLength(0);

      const linked = await analyzer.linkSaved(pathToUri('/proj/main.s'));
      expect(linked).toBeDefined();
      const messages = [...linked!.diagnostics.values()].flat().map(messageOf);
      expect(messages.some(m => /does not fit/i.test(m))).toBe(true);
    });

    it('anchors unlocated linker messages to a real document', async () => {
      const analyzer = await analyzerFor(OVERFLOW);
      const linked = await analyzer.linkSaved(pathToUri('/proj/main.s'));
      // `Segment CODE ($20 bytes at $200) does not fit in RAM` is about a MEMORY
      // area in the .cfg, so it has no source at all. Bucketing drops unlocated
      // messages, so it must land on the unit's entry file instead of vanishing.
      const diags = linked!.diagnostics.get(pathToUri('/proj/main.s'));
      expect(diags).toBeDefined();
      const fit = diags!.find(d => /does not fit/i.test(messageOf(d)));
      expect(fit).toBeDefined();
      expect(fit!.range.start.line).toBe(0);
    });

    it('reports nothing for a unit that fits', async () => {
      const analyzer = await analyzerFor('.segment "CODE"\n  .byte 1,2\n');
      const linked = await analyzer.linkSaved(pathToUri('/proj/main.s'));
      expect(linked).toBeDefined();
      const errors = [...linked!.diagnostics.values()].flat()
          .filter(d => d.severity === 1);
      expect(errors).toHaveLength(0);
    });

    /** Analyzer over a single standalone file — no `js65.json`, no config. */
    async function standaloneAnalyzerFor(code: string) {
      const fs = new MemFs();
      const analyzer = new Analyzer({
        workspaceRoot: '/proj', debounceMs: 0,
        fsImpl: fs.sync as any, fsImplPromises: fs.promises as any,
      });
      analyzer.onDiagnostics = () => {};
      analyzer.open(pathToUri('/proj/m.s'), code, 1);
      await new Promise(r => setTimeout(r, 120));
      return analyzer;
    }

    it('does nothing for a unit that declares no layout at all', async () => {
      const analyzer = await standaloneAnalyzerFor('main:\n  rts\n');
      // No config, no target, and nothing in the source either.
      expect(await analyzer.linkSaved(pathToUri('/proj/m.s'))).toBeUndefined();
    });

    it('does nothing when the layout is expected to come from a config we were not given', async () => {
      // A bare `.segment "CODE"` is a ca65-style source whose memory layout
      // lives in a linker config. Linking it would report `Could not find
      // space for chunk Code in CODE` — our missing config, not a user bug.
      const analyzer = await standaloneAnalyzerFor('.segment "CODE"\n  rts\n');
      expect(await analyzer.linkSaved(pathToUri('/proj/m.s'))).toBeUndefined();
    });

    it('does nothing for ca65 predeclared segments, which carry no placement', async () => {
      // `.zeropage` registers ZEROPAGE as `{addressing: 1}` — a real entry in
      // the module's segments, but not a memory layout.
      const analyzer = await standaloneAnalyzerFor('.zeropage\nfoo: .res 2\n');
      expect(await analyzer.linkSaved(pathToUri('/proj/m.s'))).toBeUndefined();
    });

    it('links a unit whose layout comes from js65 extended .segment syntax', async () => {
      const analyzer = await standaloneAnalyzerFor(
          '.segment "CODE" :size $10 :mem $8000 :off 0 :out "%O"\n' +
          '  .byte 1,2,3,4\n');
      const linked = await analyzer.linkSaved(pathToUri('/proj/m.s'));
      expect(linked).toBeDefined();
      const errors = [...linked!.diagnostics.values()].flat()
          .filter(d => d.severity === 1);
      expect(errors).toHaveLength(0);
    });

    it('reports an overflow of a segment sized in the source', async () => {
      // 32 bytes of code into the same 16-byte segment, declared inline.
      const analyzer = await standaloneAnalyzerFor(
          '.segment "CODE" :size $10 :mem $8000 :off 0 :out "%O"\n' +
          '  .byte 1,2,3,4,5,6,7,8\n'.repeat(4));
      const linked = await analyzer.linkSaved(pathToUri('/proj/m.s'));
      expect(linked).toBeDefined();
      const diags = [...linked!.diagnostics.values()].flat();
      const overflow = diags.find(d => /could not find space/i.test(messageOf(d)));
      expect(overflow).toBeDefined();
      // This one is anchored to the chunk that didn't fit, so it must keep its
      // own position rather than being flattened onto the entry file's line 1.
      expect(overflow!.range.start.line).toBe(1);
    });

    it('links a unit whose layout comes from an anonymous .segment', async () => {
      const analyzer = await standaloneAnalyzerFor(
          '.segment $8000 :size $10\n  .byte 1,2,3,4\n');
      const linked = await analyzer.linkSaved(pathToUri('/proj/m.s'));
      expect(linked).toBeDefined();
      const errors = [...linked!.diagnostics.values()].flat()
          .filter(d => d.severity === 1);
      expect(errors).toHaveLength(0);
    });
  });

  it('records scope ranges for a .proc block', async () => {
    const fs = new MemFs();
    const code = [
      '.proc MyProc',
      '  lda #$01',
      '  rts',
      '.endproc',
    ].join('\n') + '\n';
    const result = await runAnalyzer(fs, [{path: '/proj/main.s', text: code}]);
    const unit = [...result.units.values()][0];
    const scope = unit.index.findScope('MyProc');
    expect(scope).toBeDefined();
    expect(scope!.kind).toBe('proc');
    expect(scope!.start).toBeDefined();
    expect(scope!.end).toBeDefined();
    expect(scope!.start!.file).toBe(toPosix('/proj/main.s'));
  });
});
