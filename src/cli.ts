
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Assembler } from './assembler.ts';
import { Cpu } from './cpu.ts';
import { Linker } from './linker.ts';
// import * as Tokens from './token.ts';
import { Preprocessor } from './preprocessor.ts';
import { clean, smudge } from './smudge.ts';
import { Tokenizer } from './tokenizer.ts';
import { SourceContents, TokenStream } from './tokenstream.ts';
import { type Module, ModuleZ } from "./module.ts";
import { sha1 } from "./sha1"
import { Base64 } from './base64.ts';

export interface CompileOptions {
  files: string[],
  outfile?: string,
}

export interface HydrateOptions {
  rom?: string,
  file?: string,
}

export interface Callbacks {
  fsReadString: (path: string, filename: string) => Promise<string>,
  fsReadBytes: (path: string, filename: string) => Promise<Uint8Array|string>,
  fsWriteString: (path: string, filename: string, data: string) => Promise<void>,
  fsWriteBytes: (path: string, filename: string, data: Uint8Array) => Promise<void>,
  fsWalk: (path: string, action: (filename: string) => Promise<boolean>) => Promise<void>,
  exit: (code: number) => void,
}

class Arguments {
  outfile = "";
  op: ((src: string, cpu: Cpu, prg: Uint8Array) => string) | undefined = undefined;
  rom = "";
  files : string[] = [];
  target = '';
  debuginfo = true;
  dbgfile = "";
  compileonly = false;
  includePaths : string[] = [];
  patch : "ips" | "" = "";
}

const DEBUG_PRINT = true;

const DEBUG = (...args : any) => {
  if (DEBUG_PRINT) {
    console.log(args);
  }
}

export class Cli {
  public static readonly STDIN : string = "//stdin";
  public static readonly STDOUT : string = "//stdout";

  sourceContents: SourceContents = new SourceContents();

  constructor(readonly callbacks: Callbacks) {
    this.callbacks = callbacks;
  }

  parseArgs(args : string[]) : Arguments {
    const out = new Arguments();
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (arg === '-h' || arg === '--help') {
        DEBUG("test help");
        this.usage(0);
      } else if (arg === '-o' || arg === '--outfile' || arg === '--output') {
        if (out.outfile) this.usage();
        out.outfile = args[++i];
      } else if (arg === '--dbgfile') {
        if (out.dbgfile) this.usage();
        out.dbgfile = args[++i];
      } else if (arg === '-g') {
        out.debuginfo = true; // This is default on contrary to most compilers.
      } else if (arg === '--no-debuginfo') {
        out.debuginfo = false; // Invert it to allow turning off debug info generation
      } else if (arg === '-c' || arg === '--compileonly') {
        out.compileonly = true;
      } else if (arg.startsWith('--output=')) {
        if (out.outfile) this.usage();
        out.outfile = arg.substring('--output='.length);
      } else if (arg === 'rehydrate') {
        out.op = smudge;
      } else if (arg === 'dehydrate') {
        out.op = clean;
      } else if (arg === '--stdin') {
        out.files.push(Cli.STDIN);
      } else if (arg === '-r' || arg === '--rom') {
        out.rom = args[++i];
      } else if (arg.startsWith('--rom=')) {
        out.rom = arg.substring('--rom='.length);
      } else if (arg === '-I' || arg === '--include-dir') {
        out.includePaths.push(args[++i]);
      } else if (arg === '--ips') {
        out.patch = "ips";
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
    DEBUG(`run: argv ${argv}`);

    const args = this.parseArgs(argv);

    DEBUG(`parsed args: ${JSON.stringify(args)}`);
    if (args.files.length === 0) {
      return this.usage(1, [new Error("No input files provided")]);
    }
    
    if (args.compileonly) {
      if (args.files.length != 1)
        return this.usage(8, [new Error("Cannot use --compileonly flag combined with multiple input files")]);
      else if (args.patch)
        return this.usage(8, [new Error(`Cannot use --compileonly flag combined with --${args.patch}`)]);
    }

    if (args.outfile == "--stdout") {
      args.outfile = Cli.STDOUT;
    } else if (args.outfile.length === 0) {
      const name = (args.files[0] == Cli.STDIN) ? "stdin" : args.files[0];
      const filename = name.replace(/\.[^/.]+$/, "");
      let ext = "";
      if (args.compileonly)
        ext = ".o";
      else if (args.patch === "ips")
        ext = ".ips";
      else
        ext = ".nes";

        args.outfile = `${filename}${ext}`;
    }
    DEBUG(`outfile: ${args.outfile}`);

    try {
      if (args.op !== undefined) {
        return this.smudge(args);
      }

      // assemble
      const modules = await this.assemble(args);
      
      if (args.compileonly) {
        DEBUG("stopping before linking cause --compileonly");
        // there should only be one module at this point

        const module = JSON.stringify(modules[0], (k, v) => {
          if (k === "data" && typeof v === "object") {
            // v == Uint8Array
            return v.toString('base64');
          }
          return v;
        }, "  ");
        await this.callbacks.fsWriteString("", args.outfile, module);
        return;
      }

      const {data, dbginfo} = await this.link(args, modules);
      
      await this.callbacks.fsWriteBytes("", args.outfile, data);
      if (args.dbgfile) {
        await this.callbacks.fsWriteString("", args.dbgfile, dbginfo);
      }
    } catch (e) {
      this.printerrors(e);
      throw e;
    }
  }

  async assemble(args: Arguments) {
    DEBUG("calling assemble");

    const modules : Module[] = [];
    for (const file of args.files) {
      DEBUG(`building asm file ${file}`);
      const asm = new Assembler(Cpu.P02);
      const opts = {
        includePaths: [
          file.substring(0, file.lastIndexOf("/")),
          ...args.includePaths
        ],
        lineContinuations: true,
        generateDebugInfo: args.debuginfo,
      };
      // const readfile = async (path: string, filename: string) => {
      //   const fullpath = await this.callbacks.fsResolve(path, filename);
      //   DEBUG(`resolved ${fullpath}`);
      //   return await this.callbacks.fsReadString(fullpath);
      // }
      // const readfilebin = async (path: string, filename: string) => {
      //   const fullpath = await this.callbacks.fsResolve(path, filename);
      //   DEBUG(`resolved ${fullpath}`);
      //   return await this.callbacks.fsReadBytes(fullpath);
      // }
      const toks = new TokenStream(this.sourceContents, this.callbacks.fsReadString, this.callbacks.fsReadBytes, opts);

      DEBUG("about to read asm file input");
      const str = await this.callbacks.fsReadString("", file).catch((err) => {
        this.usage(-1, err)
        throw err;
      });
      
      DEBUG("attempting to parse module");
      // try to parse the input as a Module first to see if its already compiled
      try {
        const obj = JSON.parse(str!);
        DEBUG(`parsed json: ${JSON.stringify(obj)}`);
        const parsedModule = await ModuleZ.safeParseAsync(obj);
        if (parsedModule.success) {
          DEBUG("successfully parsed as a module");
          // if it parsed as a module, just add it to the module list
          modules.push(parsedModule.data);
          continue;
        } else {
          // if it doesn't parse as a module, treat it as source code
          DEBUG(`not a module because zod parse failed ${parsedModule.error}`);
        }
      } catch (err) {
        // if it doesn't parse as a module, treat it as source code
        DEBUG(`not a module because json parse failed ${err}`);
      }
      const tokenizer = new Tokenizer(str!, file, this.sourceContents, opts);
      DEBUG("tokenization complete");
      // toks.enter(Tokens.concat(tokenizer));
      toks.enter(tokenizer);
      DEBUG("running preprocessor");
      const pre = new Preprocessor(toks, asm);
      // const appliedPreprocessor = await pre.tokens();
      DEBUG("applying tokens to assembly");
      // const pre2 = new Preprocessor(toks, asm);
      await asm.tokens(pre);
      DEBUG("assembly complete, writing module");
      const module = asm.module();
      module.name = file;
      modules.push(module);
    }
    return modules;
  }

  async link(args: Arguments, modules: Module[]) {
    const linker = new Linker({ target: args.target });

    DEBUG("starting linking");
    let data: string|Uint8Array|null = null;
    if (!args.patch && args.rom) {
      DEBUG(`reading ROM: ${args.rom}`);
      data = await this.callbacks.fsReadBytes("", args.rom);
      if (typeof data === "string") data = new Base64().decode(data);

      linker.base(data, 0);
    }

    for (const module of modules) {
      DEBUG(`reading module: ${module.name}`);
      linker.read(module);
    }
    DEBUG("about to run linking");
    const out = linker.link();

    DEBUG("linking complete, writing data to the output array");
    if (args.patch == "ips") {
      data = out.toIpsPatch();
    } else {
      if (!data) data = new Uint8Array(out.length);
      out.apply(data);
    }
    const dbginfo: string = !args.dbgfile ? "" : linker.getDebugInfo(this.sourceContents);
    return {data, dbginfo};
    // console.log("writing data to disk");
    // await this.callbacks.fsWriteBytes(args.outfile, data);
  }

  async smudge(args: Arguments) {
    DEBUG(`op ${args.op}`);
    if (args.files.length > 1) this.usage(1, [new Error('rehydrate and dehydrate only allow one input')]);
    DEBUG("test8");
    const src = await this.callbacks.fsReadString("",args.files[0]);
    // if (err) this.usage(3, [err]);
    DEBUG("test9");
    let fullRom: Uint8Array|undefined = undefined;
    if (args.rom) {
      DEBUG("test10");
      let inbytes = await this.callbacks.fsReadBytes("",args.rom);
      fullRom = (typeof inbytes === 'string') ? new Base64().decode(inbytes) : inbytes;
      // if (err) this.usage(4, [err]);
    } else {
      DEBUG("test11");
      const match = /smudge sha1 ([0-9a-f]{40})/.exec(src!);
      DEBUG("test12");
      if (match === undefined) this.usage(1, [new Error('no sha1 tag, must specify rom')]);
      DEBUG("test13");
      const shaTag = match![1];
      DEBUG("test14");
      await this.callbacks.fsWalk('.', async(filename) => {
        DEBUG("test callback");
        if (/\.nes$/.test(filename)) {
          let inbytes = await this.callbacks.fsReadBytes("",filename);
          inbytes = (typeof inbytes === 'string') ? new Base64().decode(inbytes) : inbytes;

          // if (err) this.usage(5, [err]);
          const sha = Array.from(
              new Uint8Array(sha1(inbytes!)),
              x => x.toString(16).padStart(2, '0')).join('');
          if (sha === shaTag) {
            fullRom = Uint8Array.from(inbytes!);
            return true;
          }
        }
        return false;
      }
      );
      DEBUG("test15");
      if (!fullRom) this.usage(1, [new Error(`could not find rom with sha ${shaTag}`)]);
    }

    DEBUG("test16");
    // TODO - read the header properly
    const prg = fullRom!.subarray(0x10, 0x40010);
    await this.callbacks.fsWriteString("", args.outfile, args.op!(src!, Cpu.P02, prg));
    // if (err) this.printerrors(err);
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
  -r FILE/--rom=FILE      Name of the file to use as a base onto which patches will be assembled.
  --ips                   Produce an IPS patch rather than a complete binary. Cannot be used with --compileonly.
  -g                      Add debug info to the assembly that can be used at link time to produce debug symbols (Default ON)
  --no-debuginfo          Disable debug info generation.
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
