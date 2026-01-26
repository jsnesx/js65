
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Cpu } from './cpu.ts';
import { clean, smudge } from './smudge.ts';
import { sha1 } from "./sha1";
import { Base64 } from './base64.ts';
import { assemble, link, type AssemblyInput, type AssemblerOptions, type LinkerOptions, type OutputFormat, type FileCallbacks } from './libassembler.ts';
import { SourceContents } from './tokenstream.ts';
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
  target = '';
  debugLevel = 0; // -1 = disabled, 0 = comments/labels only, 1 = full source
  dbgfile = "";
  compileonly = false;
  includePaths : string[] = [];
  patch : "ips" | "" = "";
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
      } else if (arg === '-g' || arg === '-g0') {
        out.debugLevel = 0; // Comments and labels only
      } else if (arg === '-g1') {
        out.debugLevel = 1; // Full source code
      } else if (arg === '--no-debuginfo') {
        out.debugLevel = -1; // Disable debug info generation
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

      // Convert CLI arguments to libassembler inputs
      const inputs: AssemblyInput[] = [];
      for (const file of args.files) {
        const code = await this.callbacks.fsReadString("", file);
        inputs.push({ type: 'source', code, name: file });
      }

      // Prepare options
      const assemblerOpts: AssemblerOptions = {
        includePaths: args.files[0] ? [
          args.files[0].substring(0, args.files[0].lastIndexOf("/")),
          ...args.includePaths
        ] : args.includePaths,
        lineContinuations: true,
        generateDebugInfo: args.debugLevel >= 0,
      };

      const callbacks: FileCallbacks = {
        readText: this.callbacks.fsReadString,
        readBinary: this.callbacks.fsReadBytes
      };

      if (args.compileonly) {
        DEBUG("stopping before linking cause --compileonly");
        // Assemble only, no linking
        const { modules, messages } = await assemble(inputs, assemblerOpts, callbacks, this.sourceContents);

        // Print any messages
        if (messages.length > 0) {
          this.printMessages(messages);
        }

        // Check for errors
        const hasErrors = messages.some(m => m.level === 'error');
        if (hasErrors) {
          this.callbacks.exit(1);
          return;
        }

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

      const linkerOpts: LinkerOptions = {
        target: args.target,
        debugLevel: args.debugLevel
      };

      // Load base ROM if specified
      if (args.rom) {
        let romData = await this.callbacks.fsReadBytes("", args.rom);
        if (typeof romData === "string") romData = new Base64().decode(romData);
        linkerOpts.baseRom = romData;
      }

      const outputFormat: OutputFormat = args.patch === "ips" ? "ips" : "binary";

      // Assemble and link with debug info
      const { modules, messages } = await assemble(inputs, assemblerOpts, callbacks, this.sourceContents);

      // Print any assembly messages
      if (messages.length > 0) {
        this.printMessages(messages);
      }

      // Check for assembly errors
      const hasAssemblyErrors = messages.some(m => m.level === 'error');
      if (hasAssemblyErrors) {
        this.callbacks.exit(1);
        return;
      }

      const result = link(modules, linkerOpts, outputFormat, this.sourceContents, messages);

      // Print any additional link messages
      const newMessages = result.messages.slice(messages.length);
      if (newMessages.length > 0) {
        this.printMessages(newMessages);
      }

      if (!result.success) {
        this.callbacks.exit(1);
        return;
      }

      await this.callbacks.fsWriteBytes("", args.outfile, result.data);

      // Write debug info if requested
      if (args.dbgfile && result.debugInfo) {
        await this.callbacks.fsWriteString("", args.dbgfile, result.debugInfo);
      }
    } catch (e) {
      this.printerrors(e);
      throw e;
    }
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
