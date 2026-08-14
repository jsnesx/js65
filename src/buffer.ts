// SPDX-License-Identifier: MPL-2.0

/** A regex match, tagged with where in the buffer it started. */
export type Match = RegExpExecArray & {line: number, column: number};

class State {
  constructor(readonly line: number,
              readonly column: number,
              readonly pos: number,
              readonly match: Match|undefined) {}
}

export class Buffer {
  pos = 0;

  lastMatch?: Match;

  constructor(readonly content: string, public line = 1, public column = 0) {}

  /** Go to the next line, handling things like multiline comments */
  private advance(s: string) {
    const len = s.length;
    let lines = 0;
    // Offset just past the last terminator, i.e. the start of the final line.
    let lineStart = 0;
    for (let i = 0; i < len; i++) {
      const c = s.charCodeAt(i);
      if (c === 0x0d /* \r */) {
        if (s.charCodeAt(i + 1) === 0x0a /* \n */) i++;
      } else if (c !== 0x0a /* \n */) {
        continue;
      }
      lines++;
      lineStart = i + 1;
    }
    this.pos += len;
    if (lines) {
      this.line += lines;
      this.column = len - lineStart;
    } else {
      this.column += len;
    }
  }

  // Skip ahead to the end of this string with a known length and no newlines
  punct(s: string) {
    const match = [s] as Match;
    match.line = this.line;
    match.column = this.column;
    this.lastMatch = match;
    this.pos += s.length;
    this.column += s.length;
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

  /** Skips a run of spaces and tabs, which can never contain a newline. */
  space(): boolean {
    const s = this.content;
    let p = this.pos;
    for (;;) {
      const c = s.charCodeAt(p);
      if (c !== 0x20 /* space */ && c !== 0x09 /* tab */) break;
      p++;
    }
    if (p === this.pos) return false;
    this.column += p - this.pos;
    this.pos = p;
    return true;
  }

  /** Skips one line terminator: `\r\n`, `\n` or `\r`. */
  newline(): boolean {
    const c = this.content.charCodeAt(this.pos);
    if (c === 0x0d /* \r */) {
      this.pos += this.content.charCodeAt(this.pos + 1) === 0x0a /* \n */ ? 2 : 1;
    } else if (c === 0x0a /* \n */) {
      this.pos++;
    } else {
      return false;
    }
    this.line++;
    this.column = 0;
    return true;
  }

  lookingAt(re: RegExp|string): boolean {
    if (typeof re === 'string') return this.content.startsWith(re, this.pos);
    re.lastIndex = this.pos;
    return re.test(this.content);
  }

  // NOTE: re should always be used with the /y sticky flag.
  token(re: RegExp): boolean {
    re.lastIndex = this.pos;
    const match = re.exec(this.content) as Match|null;
    if (!match) return false;
    match.line = this.line;
    match.column = this.column;
    this.lastMatch = match;
    this.advance(match[0]);
    return true;
  }
  tokenStr(s: string): boolean {
    let match: Match|null;
    if (!this.content.startsWith(s, this.pos)) return false;
    match = [s] as Match;
    match.line = this.line;
    match.column = this.column;
    this.lastMatch = match;
    this.advance(match[0]);
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
