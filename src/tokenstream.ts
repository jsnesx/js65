
import {Token} from './token.ts'
import {Tokenizer, Options} from './tokenizer.ts'
import * as Tokens from './token.ts';
// TODO: import raw text files seems painful right now.
import * as Generic from './macpack/generic.ts'
import * as Longbranch from './macpack/longbranch.ts'
import * as Nes2header from './macpack/nes2header.ts'

type Frame = [Tokens.Source|undefined, Token[][]];

const MAX_DEPTH = 100;

export class TokenStream implements Tokens.Source {
  private stack: Frame[] = [];
  
  constructor(
    readonly readFile?: (path: string, filename: string) => Promise<string>,
    readonly opts?: Options) {}

  async next(): Promise<Token[]|undefined> {
    while (this.stack.length) {
      const [tok, front] = this.stack[this.stack.length - 1];
      if (front.length) return front.pop()!;
      const line = await tok?.next();
      if (line) {
        if (line?.[0].token !== 'cs') return line;
        switch (line[0].str) {
          // case '.out':
          //   console.log(this.str(line));
          //   break;
          // case '.warning':
          //   console.warn(this.str(line));
          //   break;
          // case '.error':
          //   this.err(line);
          //   break;
          case '.include': {
            const path = this.str(line);
            if (!this.readFile) this.err(line);
            const paths = this.opts?.includePaths ?? ['./'];
            let code = "";
            let loaded = false;
            for (const base of paths) {
              try {
                console.log(`gonna try including base: ${base} path: ${path}`);
                code = await this.readFile(base, path);
                loaded = true;
              } catch (_e) {
                // unable to load the files at that path.
              }
            }
            if (!loaded) {
              throw new Error(`Could not find file ${path} in include directories: ${paths.join(",")}`)
            }
            // TODO - options?
            this.enter(new Tokenizer(code, path, this.opts));
            continue;
          }
          case '.macpack': {
            const pack = Tokens.expectIdentifier(line[1]);
            let code = "";
            switch (pack.toLowerCase()) {
              case "generic": {
                code = Generic.text;
                break;
              }
              case "longbranch": {
                code = Longbranch.text;
                break;
              }
              case "nes2header": {
                code = Nes2header.text;
                break;
              }
              default: {
                throw new Error(`Could not load macpack ${pack}}`);
              }
            }
            this.enter(new Tokenizer(code, `${pack}.macpack`, this.opts));
            continue;
          }
          default:
            return line;
        }
      }
      this.stack.pop();
    }
    return undefined;
  }

  unshift(...lines: Token[][]) {
    if (!this.stack.length) throw new Error(`Cannot unshift after EOF`);
    const front = this.stack[this.stack.length - 1][1];
    for (let i = lines.length - 1; i >= 0; i--) {
      front.push(lines[i]);
    }
  }

  // async include(file: string) {
  //   const code = await this.task.parent.readFile(file);
  //   this.stack.push([new Tokenizer(code, file, this.task.opts),  []]);
  // }
  // Enter a macro scope.
  enter(tokens?: Tokens.Source) {
    const frame: Frame = [undefined, []];
    if (tokens) frame[0] = tokens;
    this.stack.push(frame);
    if (this.stack.length > MAX_DEPTH) throw new Error(`Stack overflow`);
  }

  // Exit a macro scope prematurely.
  exit() {
    this.stack.pop();
  }
  // options(): Tokenizer.Options {
  //   return this.task.opts;
  // }
  
  err(line: Token[]): never {
    const msg = this.str(line);
    throw new Error(msg + Tokens.at(line[0]));
  }

  str(line: Token[]): string {
    const str = Tokens.expectString(line[1], line[0]);
    Tokens.expectEol(line[2], 'a single string');
    return str;
  }

}
