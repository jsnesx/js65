/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

type Match = RegExpExecArray & {line: number, column: number};

class State {
  constructor(readonly line: number,
              readonly column: number,
              readonly pos: number,
              readonly match: Match|undefined) {}
}

// Optimization for the buffer to keep from needing to slice the same string multiple time
// The tokenizer tends to move forward across the tokens calling substring to move to the
// next part. But on the hermes frontned, the substring calls seemed to make an internal
// copy of the string each time, whereas in the V8/browser JS engines, they have an
// optimization to lazily handle substrings to reuse the original string buffer.
// The fix I went with is to use the `y` sticky flag in the Regex engine as a cheaper
// substring. Instead of needing to substring, we can "resume" the search from the lastIndex
// to stop from needing to scan again from the start. This ends up making a large performance
// improvement for hermes when processing large files.
const stickySearchCache = new Map<string, RegExp>();
function sticky(re: RegExp): RegExp {
  const key = re.flags + ' ' + re.source;
  let s = stickySearchCache.get(key);
  if (!s) {
    // A leading '^' anchors at start-of-input. With the sticky flag the match
    // is already anchored at lastIndex, and '^' would *fail* at any pos > 0,
    // so strip it. Drop any existing g/y flag and force sticky mode.
    const flags = re.flags.replace(/[gy]/g, '') + 'y';
    const source = re.source.replace(/^\^/, '');
    s = new RegExp(source, flags);
    stickySearchCache.set(key, s);
  }
  return s;
}

export class Buffer {
  pos = 0;

  lastMatch?: Match;

  constructor(readonly content: string, public line = 1, public column = 0) {}

  private advance(s: string) {
    // s is the freshly-matched token text starting at this.pos.
    this.pos += s.length;
    s = s.replace('\n', s.includes('\r') ? '' : '\r');
    const lines = s.split(/\r/g);
    if (lines.length > 1) {
      this.line += lines.length - 1;
      this.column = 0;
    }
    this.column += lines[lines.length - 1].length;
  }

  // Run a regex anchored at the current position without using substring
  // which seemingly caused a full copy on hermes.
  private execAt(re: RegExp): Match|null {
    const s = sticky(re);
    s.lastIndex = this.pos;
    return s.exec(this.content) as Match|null;
  }

  saveState(): State {
    return new State(this.line, this.column, this.pos, this.lastMatch);
  }

  restoreState(state: State) {
    this.line = state.line;
    this.column = state.column;
    this.pos = state.pos;
    this.lastMatch = state.match;
  }

  skip(re: RegExp): boolean {
    const match = this.execAt(re);
    if (!match) return false;
    this.advance(match[0]);
    return true;
  }
  space(): boolean { return this.skip(/^[ \t]+/); }
  newline(): boolean { return this.skip(/^(\r\n|\n|\r)/); }

  lookingAt(re: RegExp|string): boolean {
    if (typeof re === 'string') return this.content.startsWith(re, this.pos);
    const s = sticky(re);
    s.lastIndex = this.pos;
    return s.test(this.content);
  }

  // NOTE: re should always be rooted with /^/ at the start.
  token(re: RegExp|string): boolean {
    let match: Match|null;
    if (typeof re === 'string') {
      if (!this.content.startsWith(re, this.pos)) return false;
      match = [re] as Match;
    } else {
      match = this.execAt(re);
    }
    if (!match) return false;
    match.line = this.line;
    match.column = this.column;
    this.lastMatch = match;
    this.advance(match[0]);

//    console.log(`TOKEN: ${re} "${match[0]}"`);
//try{throw Error();}catch(e){console.log(e);}

    return true;
  }

  lookBehind(re: RegExp|string): boolean {
    // lookBehind is not used on hot paths, so we can spend the extra time to use substring here.
    const prefix = this.content.substring(0, this.pos);
    if (typeof re === 'string') return prefix.endsWith(re);
    const match = re.exec(prefix) as Match|null;
    if (!match) return false;
    match.line = this.line;
    match.column = this.line;
    this.lastMatch = match;
    return true;
  }

  match(): Match|undefined {
    return this.lastMatch;
  }

  group(index = 0): string|undefined {
    return this.lastMatch?.[index];
  }

  eof(): boolean {
    return this.pos >= this.content.length;
  }
}
