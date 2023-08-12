import { Assembler } from './assembler.ts';
import { Cpu } from './cpu.ts';
import { Linker } from './linker.ts';
import * as Tokens from './token.ts';
import { Preprocessor } from './preprocessor.ts';
import { clean, smudge } from './smudge.ts';
import { Tokenizer } from './tokenizer.ts';
import { TokenStream } from './tokenstream.ts';

export interface CompileOptions {
  files: string[],
  outfile?: string,
}

export interface HydrateOptions {
  rom?: string,
  file?: string,
}

export interface Callbacks {
  fsReadString: (filename: string) => [string?, Error?],
  fsReadBytes: (filename: string) => [Uint8Array?, Error?],
  fsWriteString: (filename: string, data: string) => Error|undefined,
  fsWriteBytes: (filename: string, data: Uint8Array) => Error|undefined,
  fsWalk: (path: string, action: (filename: string) => boolean) => void,
  cryptoSha1: (data: Uint8Array) => ArrayBuffer,
  exit: (code: number) => void,
}

class Arguments {
  outfile = "";
  op: ((src: string, cpu: Cpu, prg: Uint8Array) => string) | undefined = undefined;
  rom = "";
  files : string[] = [];
  target = 'nes-nrom';
  compileonly = false;
}

export class Cli {
  public static readonly STDIN : string = "//stdin";
  public static readonly STDOUT : string = "//stdout";
  constructor(readonly callbacks: Callbacks) {
    this.callbacks = callbacks;
  }

  parseArgs(args : string[]) : Arguments {
    const out = new Arguments();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-h' || arg === '--help') {
        console.log("test help");
        this.usage(0);
      } else if (arg === '-o' || arg === '--outfile') {
        if (out.outfile) this.usage();
        out.outfile = args[++i];
      } else if (arg === '-c' || arg === '--compileonly') {
        out.compileonly = true;
      } else if (arg === '--output=') {
        if (out.outfile) this.usage();
        out.outfile = arg.substring('--rom='.length);
      } else if (arg === 'rehydrate') {
        out.op = smudge;
      } else if (arg === 'dehydrate') {
        out.op = clean;
      } else if (arg === '--stdin') {
        out.files.push(Cli.STDIN);
      } else if (arg === '--rom') {
        out.rom = args[++i];
      } else if (arg === '--target') {
        out.target = args[++i];
      } else if (arg.startsWith('--rom=')) {
        out.rom = arg.substring('--rom='.length);
      } else if (arg.startsWith('--target=')) {
        out.target = arg.substring('--target='.length);
      } else {
        out.files.push(arg);
      }
    }
    return out;
  }

  public async run(argv: string[]) {
    console.log(`test1 ${argv}`);

    const args = this.parseArgs(argv);

    console.log("test3");
    if (args.files.length === 0) {
      return this.usage(1, [new Error("No input files provided")]);
    }
    
    console.log("test4");
    if (!args.outfile) args.outfile = args.files[0].substring(0, args.files[0].lastIndexOf(".")) + (args.compileonly) ? ".o" : ".nes";
    if (args.outfile == "--stdout") args.outfile = Cli.STDOUT;
    
    // assemble
    if (args.rom) this.usage(1, [new Error('--rom only allowed with rehydrate or dehydrate')]);

    try {
      if (args.op !== undefined) {
        return this.smudge(args);
      }

      await this.assemble(args);
    } catch (e) {
      this.printerrors(e);
      throw e;
    }
  }

  async assemble(args: Arguments) {
    console.log("test17");
    const that = this;
    function tokenizer(path: string) : [Tokenizer|undefined, Error|undefined] {
      const [str, err] = that.callbacks.fsReadString(path);
      if (err) return [undefined, err];
      return [new Tokenizer(str!, path, {lineContinuations: true}), undefined];
    }

    console.log(`test18 ${args.files}`);
    const asm = new Assembler(Cpu.P02);
    const toks = new TokenStream();
    console.log("test19");
    const sources = await Promise.all(args.files.map(tokenizer));
    const [srcs, errs] = unzip(sources);
    const allErrs = errs.filter((err) => err != undefined).map(err => err!);
    if (allErrs.length > 0) return this.printerrors(...allErrs);
    console.log("test20");
    toks.enter(Tokens.concat(...srcs.map(src => src!)));
    console.log("test21");
    const pre = new Preprocessor(toks, asm);
    asm.tokens(pre);
    console.log("test22");

    const modules = asm.module();
    if (args.compileonly) {
      console.log("ending cause compileonly");
      // const data = new Uint8Array(modules);
      // this.callbacks.fsWriteBytes(args.outfile, data);
      return;
    }

    const linker = new Linker({ target: args.target });
    console.log("test23");
    //linker.base(this.prg, 0);
    linker.read(modules);
    console.log("test24");
    const out = linker.link();
    console.log("test25");
    const data = new Uint8Array(out.length);
    out.apply(data);
    console.log("test26");
    this.callbacks.fsWriteBytes(args.outfile, data);
    console.log("test27");
  }

  smudge(args: Arguments) {
    console.log(`op ${args.op}`);
    if (args.files.length > 1) this.usage(1, [new Error('rehydrate and dehydrate only allow one input')]);
    console.log("test8");
    let [src, err] = this.callbacks.fsReadString(args.files[0]);
    if (err) this.usage(3, [err]);
    console.log("test9");
    let fullRom: Uint8Array|undefined;
    if (args.rom) {
      console.log("test10");
      [fullRom, err] = this.callbacks.fsReadBytes(args.rom);
      if (err) this.usage(4, [err]);
    } else {
      console.log("test11");
      const match = /smudge sha1 ([0-9a-f]{40})/.exec(src!);
      console.log("test12");
      if (match === undefined) this.usage(1, [new Error('no sha1 tag, must specify rom')]);
      console.log("test13");
      const shaTag = match![1];
      console.log("test14");
      this.callbacks.fsWalk('.', (filename) => {
        console.log("test callback");
        if (/\.nes$/.test(filename)) {
          const [data, err] = this.callbacks.fsReadBytes(filename);
          if (err) this.usage(5, [err]);
          const sha = Array.from(
              new Uint8Array(this.callbacks.cryptoSha1(data!)),
              x => x.toString(16).padStart(2, '0')).join('');
          if (sha === shaTag) {
            fullRom = Uint8Array.from(data!);
            return true;
          }
        }
        return false;
      }
      );
      console.log("test15");
      if (!fullRom) this.usage(1, [new Error(`could not find rom with sha ${shaTag}`)]);
    }

    console.log("test16");
    // TODO - read the header properly
    const prg = fullRom!.subarray(0x10, 0x40010);
    err = this.callbacks.fsWriteString(args.outfile, args.op!(src!, Cpu.P02, prg));
    if (err) this.printerrors(err);
  }

  printerrors(...err: Error[]) {
    for (let i = 0; i < err.length; i++) {
      console.log(`js65 Error: ${err[i].message}`);
    }
    if (err.length > 1) {
      console.log(`js65: Multiple errors`);
    }
  }

  public usage(code = 1, err: Error[]|undefined = undefined) {
    if (err) this.printerrors(...err);
    console.log(`\
Usage: js65 [options] FILE[...]
  Assembles and links all files into output
Usage: js65 rehydrate|dehydrate -r|--rom=<rom> FILE
  Remove/Re-add data in an assembly file from the original ROM.

===

Assembler Options:

positional arguments:
  FILE[...] a list of one or more files or --stdin to read input from stdin

optional arguments:
  -o FILE/--output=FILE   Name of the file to write or --stdout. If not provided, writes to \`<filename>.nes\`
  -c/--compileonly        Compile and assemble, but don't link. Outputs a module that can be linked later.
  -h/--help               Print this help text and exit.

===

Hydrate Options:
  The smudged asm file can be rebuilt into a regular file by providing the same rom image.
  This can be used to share a disassembled game's code without sharing the data.

required arguments:
  FILE                 The assembly file to dehydrate or rehydrate
  rehydrate|dehydrate  Convert the file to either remove all data (dehydrate) or re-add data from rom ()
  -r/--rom             ROM image to use. If not provided, js65 will search in the directory structure for
                        a rom that matches the sha-1 provided in the header of the assembly FILE
`);
    this.callbacks.exit(code);
  }

}

function unzip<
  T extends [...{ [K in keyof S]: S[K] }][], S extends any[]
>(arr: [...T]): T[0] extends infer A 
  ? { [K in keyof A]: T[number][K & keyof T[number]][] } 
  : never 
{
  const maxLength = Math.max(...arr.map((x) => x.length));

  return arr.reduce(
    (acc: any, val) => {
      val.forEach((v, i) => acc[i].push(v));

      return acc;
    },
    range(maxLength).map(() => [])
  );
}

function range(size: number, startAt = 0) {
  return [...Array(size).keys()].map(i => i + startAt);
}
