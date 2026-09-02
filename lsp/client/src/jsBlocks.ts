// SPDX-License-Identifier: MPL-2.0

/**
 * Makes the JavaScript in `.jsbegin` blocks legible to the editor's JS tooling.
 *
 * The grammar already colours a block as JavaScript. This module supplies the
 * names a block can actually use: `a` and `defines` from the shipped global
 * declarations, plus one binding per `.jsinput` in the file, whose type depends
 * on whether the pattern is a glob.
 */

const GLOB_META = /[*?]/;

const RE_JSBEGIN = /^\s*\.jsbegin\b/i;
const RE_JSEND = /^\s*\.jsend\b/i;
// `.jsinput <name>, "<path>"`, matching the preprocessor's own parse.
const RE_JSINPUT = /^\s*\.jsinput\s+([A-Za-z_$][\w$]*)\s*,\s*(?:"([^"]*)"|'([^']*)')/i;

/** A `.jsbegin`/`.jsend` body, as 0-based end-exclusive lines. */
export interface JsBlock {
  startLine: number;
  endLine: number;
}

export interface JsInputBinding {
  name: string;
  pattern: string;
  isGlob: boolean;
}

export interface JsBlockScan {
  blocks: JsBlock[];
  inputs: JsInputBinding[];
}

/** Finds the blocks and `.jsinput` bindings in a document. */
export function scanJsBlocks(text: string): JsBlockScan {
  const lines = text.split(/\r?\n/);
  const blocks: JsBlock[] = [];
  const inputs: JsInputBinding[] = [];
  const seen = new Set<string>();
  let start: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    if (start === undefined) {
      if (RE_JSBEGIN.test(lines[i])) { start = i + 1; continue; }
      const m = RE_JSINPUT.exec(lines[i]);
      if (m) {
        const name = m[1];
        const pattern = m[2] ?? m[3];
        // A repeated name is the same binding, and declaring it twice is an error.
        if (!seen.has(name)) {
          seen.add(name);
          inputs.push({name, pattern, isGlob: GLOB_META.test(pattern)});
        }
      }
      continue;
    }
    if (RE_JSEND.test(lines[i])) {
      blocks.push({startLine: start, endLine: i});
      start = undefined;
    }
  }
  // An unterminated block still runs to the end of the file for editing purposes.
  if (start !== undefined) blocks.push({startLine: start, endLine: lines.length});
  return {blocks, inputs};
}

/** The `.jsinput` half of the ambient declarations, which varies per file. */
export function renderInputDeclarations(inputs: readonly JsInputBinding[]): string {
  return inputs.map(({name, pattern, isGlob}) => {
    const type = isGlob ? 'JsInputFile[]' : 'JsInputFile';
    return `/** \`.jsinput ${name}, "${pattern}"\` */\ndeclare const ${name}: ${type};`;
  }).join('\n\n');
}

export function blockAt(blocks: readonly JsBlock[], line: number): JsBlock | undefined {
  return blocks.find(b => line >= b.startLine && line < b.endLine);
}
