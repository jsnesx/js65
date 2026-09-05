// SPDX-License-Identifier: MPL-2.0

/**
 * Locating `.jsbegin`/`.jsend` bodies in raw document text.
 *
 * The bodies are JavaScript, not assembly, so every assembler-side feature has
 * to leave them alone.
 */

const RE_JSBEGIN = /^\s*\.jsbegin\b/i;
const RE_JSEND = /^\s*\.jsend\b/i;

/** True when a 0-based line is in a block body (the directives themselves are not). */
export function inJsBlock(text: string, line: number): boolean {
  const lines = text.split(/\r?\n/);
  if (line >= lines.length) return false;
  let inBlock = false;
  for (let i = 0; i <= line; i++) {
    if (inBlock) {
      if (RE_JSEND.test(lines[i])) inBlock = false;
    } else if (RE_JSBEGIN.test(lines[i])) {
      inBlock = true;
      continue;
    }
    if (i === line) return inBlock;
  }
  return false;
}

/**
 * Wipe the contents of the javascript block so we don't build any sorta
 * asm related semantic analysis for the block. Line count is preserved so
 * every other line keeps its position.
 */
export function blankJsBlocks(text: string): string {
  const lines = text.split(/\r?\n/);
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    if (!inBlock) {
      if (RE_JSBEGIN.test(lines[i])) inBlock = true;
      continue;
    }
    if (RE_JSEND.test(lines[i])) inBlock = false;
    else lines[i] = '';
  }
  return lines.join('\n');
}
