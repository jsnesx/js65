import { Assembler } from './assembler.ts';
import { Cpu } from './cpu.ts';
import { Linker } from './linker.ts';
// import * as Tokens from './token.ts';
import { Preprocessor } from './preprocessor.ts';
import { clean, smudge } from './smudge.ts';
import { Tokenizer } from './tokenizer.ts';
import { TokenStream } from './tokenstream.ts';
import { Module, ModuleZ } from "./module.ts";
import base64 from 'base64';

export interface CompileOptions {
  files: string[],
  outfile?: string,
}

export interface HydrateOptions {
  rom?: string,
  file?: string,
}

export interface Callbacks {
  fsResolve: (path: string, filename: string) => Promise<string>,
  fsReadString: (filename: string) => Promise<[string?, Error?]>,
  fsReadBytes: (filename: string) => Promise<[Uint8Array?, Error?]>,
  fsWriteString: (filename: string, data: string) => Promise<Error|undefined>,
  fsWriteBytes: (filename: string, data: Uint8Array) => Promise<Error|undefined>,
  fsWalk: (path: string, action: (filename: string) => Promise<boolean>) => Promise<void>,
  cryptoSha1: (data: Uint8Array) => ArrayBuffer,
  exit: (code: number) => void,
}

class Arguments {
  outfile = "";
  op: ((src: string, cpu: Cpu, prg: Uint8Array) => string) | undefined = undefined;
  rom = "";
  files : string[] = [];
  target = '';
  compileonly = false;
  includePaths : string[] = [];
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
      } else if (arg.startsWith('--rom=')) {
        out.rom = arg.substring('--rom='.length);
      } else if (arg === '-I' || arg === '--include-dir') {
        out.includePaths.push(args[++i]);
      } else if (arg.startsWith('-I')) {
        out.includePaths.push(arg.substring('-I'.length));
      } else if (arg.startsWith('--include-dir')) {
        out.includePaths.push(arg.substring('--include-dir'.length));
      } else if (arg === '--target') {
        out.target = args[++i];
      } else if (arg.startsWith('--target=')) {
        out.target = arg.substring('--target='.length);
      } else {
        out.files.push(arg);
      }
    }
    return out;
  }

  public async run(argv: string[]) {
    console.log(`run: argv ${argv}`);

    const args = this.parseArgs(argv);

    console.log(`parsed args: ${JSON.stringify(args)}`);
    if (args.files.length === 0) {
      return this.usage(1, [new Error("No input files provided")]);
    }
    
    if (args.compileonly && args.files.length != 1) {
      return this.usage(8, [new Error("Cannot use --compileonly flag combined with multiple input files")]);
    }

    if (args.outfile.length === 0) {
      const name = (args.files[0] == Cli.STDIN) ? "stdin" : args.files[0];
      const filename = name.replace(/\.[^/.]+$/, "");
      args.outfile = `${filename}${(args.compileonly) ? ".o" : ".nes"}`;
    }
    if (args.outfile == "--stdout") args.outfile = Cli.STDOUT;
    console.log(`outfile: ${args.outfile}`);

    try {
      if (args.op !== undefined) {
        return this.smudge(args);
      }

      // assemble
      if (args.rom) this.usage(1, [new Error('--rom only allowed with rehydrate or dehydrate')]);

      const modules = await this.assemble(args);
      
      if (args.compileonly) {
        console.log("stopping before linking cause --compileonly");
        // there should only be one module at this point

        const module = JSON.stringify(modules[0], (k, v) => {
          if (k === "data" && typeof v === "object") {
            // v == Uint8Array
            return base64.fromArrayBuffer(v);
          }
          return v;
        }, "  ");
        await this.callbacks.fsWriteString(args.outfile, module);
        return;
      }

      this.link(args, modules);
    } catch (e) {
      this.printerrors(e);
      throw e;
    }
  }


  async assemble(args: Arguments) {
    console.log("calling assemble");

    const modules : Module[] = [];
    for (const file of args.files) {
      console.log(`building asm file ${file}`);
      const asm = new Assembler(Cpu.P02);
      const opts = {
        includePaths: [
          file.substring(0, file.lastIndexOf("/")),
          ...args.includePaths
        ],
        lineContinuations: true
      };
      const readfile = async (path: string, filename: string) => {
        const fullpath = await this.callbacks.fsResolve(path, filename);
        // console.log(`resolved ${fullpath}`);
        if (err) throw err;
        return await this.callbacks.fsReadString(fullpath)
          .then((result) => {
            const [str, err] = result;
            if (err) throw err;
            return str!;
          });
      }
      const readfilebin = async (path: string, filename: string) => {
        const fullpath = await this.callbacks.fsResolve(path, filename);
        // console.log(`resolved ${fullpath}`);
        if (err) throw err;
        return await this.callbacks.fsReadBytes(fullpath)
          .then((result) => {
            const [str, err] = result;
            if (err) throw err;
            return str!;
          });
      }
      const toks = new TokenStream(readfile, readfilebin, opts);

      console.log("about to read asm file input");
      const [str, err] = await this.callbacks.fsReadString(file);
      if (err) throw err;
      
      console.log("attempting to parse module");
      // try to parse the input as a Module first to see if its already compiled
      try {
        const obj = JSON.parse(str!);
        console.log(`parsed json: ${JSON.stringify(obj)}`);
        const parsedModule = await ModuleZ.safeParseAsync(obj);
        if (parsedModule.success) {
          console.log("successfully parsed as a module");
          // if it parsed as a module, just add it to the module list
          modules.push(parsedModule.data);
          continue;
        } else {
          // if it doesn't parse as a module, treat it as source code
          console.log(`not a module because zod parse failed ${parsedModule.error}`);
        }
      } catch (err) {
        // if it doesn't parse as a module, treat it as source code
        console.log(`not a module because json parse failed ${err}`);
      }
      const tokenizer = new Tokenizer(str!, file, opts);
      console.log("tokenization complete");
      // toks.enter(Tokens.concat(tokenizer));
      toks.enter(tokenizer);
      console.log("running preprocessor");
      const pre = new Preprocessor(toks, asm);
      console.log("applying tokens to assembly");
      await asm.tokens(pre);
      console.log("assembly complete, writing module");
      const module = asm.module();
      module.name = file;
      modules.push(module);
    }
    return modules;
  }

  async link(args: Arguments, modules: Module[]) {
    const linker = new Linker({ target: args.target });
    console.log("starting linking");
    //linker.base(this.prg, 0);
    for (const module of modules) {
      console.log(`reading module: ${module.name}`);
      linker.read(module);
    }
    console.log("about to run linking");
    const out = linker.link();
    console.log("linking complete, writing data to the output array");
    const data = new Uint8Array(out.length);
    out.apply(data);
    console.log("writing data to disk");
    await this.callbacks.fsWriteBytes(args.outfile, data);
  }

  async smudge(args: Arguments) {
    console.log(`op ${args.op}`);
    if (args.files.length > 1) this.usage(1, [new Error('rehydrate and dehydrate only allow one input')]);
    console.log("test8");
    let [src, err] = await this.callbacks.fsReadString(args.files[0]);
    if (err) this.usage(3, [err]);
    console.log("test9");
    let fullRom: Uint8Array|undefined;
    if (args.rom) {
      console.log("test10");
      [fullRom, err] = await this.callbacks.fsReadBytes(args.rom);
      if (err) this.usage(4, [err]);
    } else {
      console.log("test11");
      const match = /smudge sha1 ([0-9a-f]{40})/.exec(src!);
      console.log("test12");
      if (match === undefined) this.usage(1, [new Error('no sha1 tag, must specify rom')]);
      console.log("test13");
      const shaTag = match![1];
      console.log("test14");
      this.callbacks.fsWalk('.', async(filename) => {
        console.log("test callback");
        if (/\.nes$/.test(filename)) {
          const [data, err] = await this.callbacks.fsReadBytes(filename);
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
    err = await this.callbacks.fsWriteString(args.outfile, args.op!(src!, Cpu.P02, prg));
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

// function unzip<
// // deno-lint-ignore no-explicit-any
//   T extends [...{ [K in keyof S]: S[K] }][], S extends any[]
// >(arr: [...T]): T[0] extends infer A 
//   ? { [K in keyof A]: T[number][K & keyof T[number]][] } 
//   : never 
// {
//   const maxLength = Math.max(...arr.map((x) => x.length));

//   return arr.reduce(
//     // deno-lint-ignore no-explicit-any
//     (acc: any, val) => {
//       val.forEach((v, i) => acc[i].push(v));

//       return acc;
//     },
//     range(maxLength).map(() => [])
//   );
// }

// function range(size: number, startAt = 0) {
//   return [...Array(size).keys()].map(i => i + startAt);
// }
