
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Cpu } from './cpu.ts';
import { clean, smudge } from './smudge.ts';
import { sha1 } from "./sha1";
import { Base64 } from './base64.ts';
import { compile, findOutput, type AssemblyInput, type Js65Options, type FileCallbacks } from './libassembler.ts';
import * as Tokens from './token.ts';

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
  dbgfile = "";
  compileonly = false;
  patch : "ips" | "" = "";
  options: Js65Options = {
    includePaths: [],
    lineContinuations: true,
    debugLevel: 0, // -1 = disabled, 0 = comments/labels only, 1 = full source
    generateDebugInfo: true,
  };
}

const DEBUG_PRINT = false;

const DEBUG = (...args : any) => {
  if (DEBUG_PRINT) {
    console.log(args);
  }
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
        this.usage(0);
      } else if (arg === '-o' || arg === '--outfile' || arg === '--output') {
        if (out.outfile) this.usage();
        out.outfile = args[++i];
      } else if (arg === '--dbgfile') {
        if (out.dbgfile) this.usage();
        out.dbgfile = args[++i];
      } else if (arg === '-g' || arg === '-g0') {
        out.options.debugLevel = 0; // Comments and labels only
        out.options.generateDebugInfo = true;
      } else if (arg === '-g1') {
        out.options.debugLevel = 1; // Full source code
        out.options.generateDebugInfo = true;
      } else if (arg === '--no-debuginfo') {
        out.options.debugLevel = -1; // Disable debug info generation
        out.options.generateDebugInfo = false;
      } else if (arg === '-c' || arg === '--compileonly') {
        out.compileonly = true;
        out.options.outputFormat = 'object';
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
        out.options.includePaths!.push(args[++i]);
      } else if (arg === '--ips') {
        out.patch = "ips";
        out.options.outputFormat = 'ips';
      } else if (arg.startsWith('-I')) {
        out.options.includePaths!.push(arg.substring('-I'.length));
      } else if (arg.startsWith('--include-dir')) {
        out.options.includePaths!.push(arg.substring('--include-dir'.length));
      } else if (arg === '--target') {
        out.options.target = args[++i];
      } else if (arg.startsWith('--target=')) {
        out.options.target = arg.substring('--target='.length);
      } else {
        out.files.push(arg);
      }
    }
    return out;
  }

  public async run(argv: string[]) {
    const args = this.parseArgs(argv);

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

    try {
      if (args.op !== undefined) {
        return this.smudge(args);
      }

      // Convert CLI arguments to libassembler inputs
      const inputs: AssemblyInput[] = [];
      for (const file of args.files) {
        const code = await this.callbacks.fsReadString("", file);
        inputs.push({ type: 'source', code, name: file });
      }

      // Seed the include path with the first file's directory
      args.options.includePaths = args.files[0] ? [
        args.files[0].substring(0, args.files[0].lastIndexOf("/")),
        ...(args.options.includePaths ?? [])
      ] : (args.options.includePaths ?? []);

      // Load base ROM if specified
      let baseRom: Uint8Array | undefined;
      if (args.rom) {
        let romData = await this.callbacks.fsReadBytes("", args.rom);
        if (typeof romData === "string") romData = new Base64().decode(romData);
        baseRom = romData;
      }

      const callbacks: FileCallbacks = {
        readText: this.callbacks.fsReadString,
        readBinary: this.callbacks.fsReadBytes
      };

      const result = await compile(inputs, args.options, callbacks, baseRom);

      if (result.messages.length > 0) {
        this.printMessages(result.messages);
      }

      if (!result.success) {
        this.callbacks.exit(1);
        return;
      }

      // The linked ROM / first artifact goes to outfile for now
      const primary = result.outputs.find(o => o.type !== 'debug') ?? result.outputs[0];
      await this.callbacks.fsWriteBytes("", args.outfile, primary.data);

      // Write debug info if requested
      const debug = findOutput(result, 'debug');
      if (args.dbgfile && debug) {
        await this.callbacks.fsWriteBytes("", args.dbgfile, debug.data);
      }
    } catch (e) {
      this.printerrors(e);
      throw e;
    }
  }

  async smudge(args: Arguments) {
    if (args.files.length > 1) this.usage(1, [new Error('rehydrate and dehydrate only allow one input')]);
    const src = await this.callbacks.fsReadString("",args.files[0]);
    // if (err) this.usage(3, [err]);
    let fullRom: Uint8Array|undefined = undefined;
    if (args.rom) {
      let inbytes = await this.callbacks.fsReadBytes("",args.rom);
      fullRom = (typeof inbytes === 'string') ? new Base64().decode(inbytes) : inbytes;
      // if (err) this.usage(4, [err]);
    } else {
      const match = /smudge sha1 ([0-9a-f]{40})/.exec(src!);
      if (match === undefined) this.usage(1, [new Error('no sha1 tag, must specify rom')]);
      const shaTag = match![1];
      await this.callbacks.fsWalk('.', async(filename) => {
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
      if (!fullRom) this.usage(1, [new Error(`could not find rom with sha ${shaTag}`)]);
    }

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

  printMessages(messages: Tokens.AssemblerMessage[]) {
    for (const msg of messages) {
      const levelPrefix = msg.level === 'error' ? 'Error' : msg.level === 'warning' ? 'Warning' : 'Info';
      const location = msg.source ? Tokens.at({ source: msg.source }) : '';
      console.log(`js65 ${levelPrefix}: ${msg.message}${location}`);
    }
    const errorCount = messages.filter(m => m.level === 'error').length;
    const warningCount = messages.filter(m => m.level === 'warning').length;
    if (errorCount > 0 || warningCount > 0) {
      const parts = [];
      if (errorCount > 0) parts.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}`);
      if (warningCount > 0) parts.push(`${warningCount} warning${warningCount !== 1 ? 's' : ''}`);
      console.log(`js65: ${parts.join(', ')}`);
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
  --dbgfile FILE          Output debug symbols to the specified file.
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
