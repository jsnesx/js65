// SPDX-License-Identifier: MPL-2.0

type Match = RegExpExecArray & {line: number, column: number};

class State {
  constructor(readonly line: number,
              readonly column: number,
              readonly pos: number,
              readonly match: Match|undefined) {}
}

const RE_SPACE = /[ \t]+/y;
const RE_NEWLINE = /(\r\n|\n|\r)/y;

export class Buffer {
  pos = 0;

  lastMatch?: Match;

  constructor(readonly content: string, public line = 1, public column = 0) {}

  private advance(s: string) {
    // fast path for skipping the check for newlines when advancing since
    // almost all tokens we skip by don't have a newline in them
    if (!s.includes('\n') && !s.includes('\r')) {
      this.column += s.length;
      this.pos += s.length;
      return;
    }
    // slow path if the token has newlines in it, we want to split it and move
    // to the next line/column/etc
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
    re.lastIndex = this.pos;
    const match = re.exec(this.content) as Match|null;
    if (!match) return false;
    this.advance(match[0]);
    return true;
  }
  space(): boolean { return this.skip(RE_SPACE); }
  newline(): boolean { return this.skip(RE_NEWLINE); }

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
