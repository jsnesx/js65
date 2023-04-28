
import {Token} from './token.ts'
import * as Tokens from './token.ts';
import {Tokenizer, Options} from './tokenizer.ts';
import {TokenStream} from './tokenstream.ts';

export class IncludeWrapper implements Tokens.Async {
  constructor(
      readonly readFile: (path: string) => Promise<string>,
      readonly source: Tokens.Source, readonly stream: TokenStream,
      readonly opts?: Options) {}

  async nextAsync(): Promise<Token[]|undefined> {
    while (true) {
      const line = this.source.next();
      if (line?.[0].token !== 'cs') return line;
      if (line[0].str !== '.include') return line;
      const path = str(line);
      const code = await this.readFile(path);
      // TODO - options?
      this.stream.enter(new Tokenizer(code, path, this.opts));
    }
  }
}

export class ConsoleWrapper implements Tokens.Source {
  constructor(readonly source: Tokens.Source) {}

  next() {
    while (true) {
      const line = this.source.next();
      if (line?.[0].token !== 'cs') return line;
      switch (line[0].str) {
        case '.out':
          console.log(str(line));
          break;
        case '.warning':
          console.warn(str(line));
          break;
        case '.error':
          err(line);
          break;
        default:
          return line;
      }
    }
  }
}

function err(line: Token[]): never {
  const msg = str(line);
  throw new Error(msg + Tokens.at(line[0]));
}

function str(line: Token[]): string {
  const str = Tokens.expectString(line[1], line[0]);
  Tokens.expectEol(line[2], 'a single string');
  return str;
}
