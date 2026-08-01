
// SPDX-License-Identifier: MPL-2.0

import { Cpu } from './cpu.ts';
import { clean, smudge } from './smudge.ts';
import { sha1 } from "./sha1";
import { Base64 } from './base64.ts';
import { compile, findOutput, isGzip, deserializeObjectFile, type AssemblyInput, type Js65Options, type FileCallbacks } from './libassembler.ts';
import * as Tokens from './token.ts';
import { dirOf } from './util.ts';

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
  mapfile = "";
  cfgfile = "";
  compileonly = false;
  patch : "ips" | "" = "";
  options: Js65Options = {
    includePaths: [],
    binIncludePaths: [],
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

  // Keep a local cache of sources opened and compiled for diagnostic printing
  // later so we don't need to reload the files
  private readonly sources = new Map<string, string>();
  private readonly sourceLines = new Map<string, string[]>();

  constructor(readonly callbacks: Callbacks) {
    this.callbacks = callbacks;
  }

  // Load the file and keep the source code in our local cache for later.
  private async readSource(path: string, filename: string): Promise<string> {
    const code = await this.callbacks.fsReadString(path, filename);
    this.sources.set(filename, code);
    this.sourceLines.delete(filename);
    return code;
  }

  /**
   * Peak at the file as a binary input and check to see if its a gzip file or
   * a text file (skipping over the BOM if its there)
   */
  private async readInput(filename: string): Promise<AssemblyInput> {
    let bytes = await this.callbacks.fsReadBytes("", filename);
    if (typeof bytes === "string") bytes = new Base64().decode(bytes);
    if (isGzip(bytes)) {
      return { type: 'module', module: deserializeObjectFile(bytes, filename) };
    }
    // Frontends also strip the BOM, but it doesn't hurt to check it in this path too.
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
    const code = new TextDecoder().decode(bytes);
    // No assembly source starts with `{` so error out if it didn't decompress earlier.
    if (code.trimStart().startsWith('{')) {
      throw new Error(`${filename}: not a valid object file`);
    }
    this.sources.set(filename, code);
    this.sourceLines.delete(filename);
    return { type: 'source', code, name: filename };
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
      } else if (arg === '-m' || arg === '--mapfile') {
        if (out.mapfile) this.usage();
        out.mapfile = args[++i];
      } else if (arg.startsWith('--mapfile=')) {
        out.mapfile = arg.substring('--mapfile='.length);
      } else if (arg === '-C' || arg === '--config') {
        if (out.cfgfile) this.usage();
        out.cfgfile = args[++i];
      } else if (arg.startsWith('--config=')) {
        if (out.cfgfile) this.usage();
        out.cfgfile = arg.substring('--config='.length);
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
      } else if (arg === '--bin-include-dir') {
        out.options.binIncludePaths!.push(args[++i]);
      } else if (arg.startsWith('--bin-include-dir=')) {
        out.options.binIncludePaths!.push(arg.substring('--bin-include-dir='.length));
      } else if (arg === '-I' || arg === '--include-dir') {
        out.options.includePaths!.push(args[++i]);
      } else if (arg === '--ips') {
        out.patch = "ips";
        out.options.outputFormat = 'ips';
      } else if (arg.startsWith('--include-dir=')) {
        out.options.includePaths!.push(arg.substring('--include-dir='.length));
      } else if (arg.startsWith('-I')) {
        out.options.includePaths!.push(arg.substring('-I'.length));
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
      else if (args.mapfile)
        return this.usage(8, [new Error("Cannot use --compileonly flag combined with -m/--mapfile")]);
      else if (args.cfgfile)
        return this.usage(8, [new Error("Cannot use --compileonly flag combined with -C/--config")]);
    }

    if (args.mapfile) args.options.generateMapFile = true;

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
        inputs.push(await this.readInput(file));
      }

      // Seed the include path with each input file's directory, so a file given as
      // `ABC/xyz.s` finds its siblings in folder `ABC` even when the assembler is
      // run from elsewhere.
      args.options.includePaths = [
        ...args.files.filter(f => f !== Cli.STDIN).map(dirOf),
        ...(args.options.includePaths ?? []),
      ];

      // Load the ld65 linker config, if given. readSource caches the text so a
      // parse error further in gets a source snippet like any other file.
      if (args.cfgfile) {
        args.options.linkerConfig = await this.readSource("", args.cfgfile);
        args.options.linkerConfigName = args.cfgfile;
      }

      // Load base ROM if specified
      let baseRom: Uint8Array | undefined;
      if (args.rom) {
        let romData = await this.callbacks.fsReadBytes("", args.rom);
        if (typeof romData === "string") romData = new Base64().decode(romData);
        baseRom = romData;
      }

      const callbacks: FileCallbacks = {
        readText: (path, filename) => this.readSource(path, filename),
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
      const primary = result.outputs.find(o => o.type === 'binary' || o.type === 'object')
          ?? result.outputs[0];
      await this.callbacks.fsWriteBytes("", args.outfile, primary.data);

      // A linker config can send segments to files of their own. Their names
      // come from the config verbatim, so `%O` still has to be filled in.
      for (const extra of result.outputs) {
        if (extra === primary || extra.type !== 'binary') continue;
        await this.callbacks.fsWriteBytes(
            "", extra.name.replace(/%O/g, args.outfile), extra.data);
      }

      // Write debug info if requested
      const debug = findOutput(result, 'debug');
      if (args.dbgfile && debug) {
        await this.callbacks.fsWriteBytes("", args.dbgfile, debug.data);
      }

      // Write the linker map if requested
      const map = findOutput(result, 'map');
      if (args.mapfile && map) {
        await this.callbacks.fsWriteBytes("", args.mapfile, map.data);
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

  // Builds the `file:line:col: ` when we know where we are, else the program name
  private locationPrefix(source?: Tokens.SourceInfo): string {
    if (!source || !source.file || source.line <= 0) return 'js65: ';
    return `${source.file}:${source.line}:${source.column + 1}: `;
  }

  // Load the code around the location for creating the inline snippet in the error message
  private snippet(source?: Tokens.SourceInfo): string[] {
    if (!source || source.line <= 0) return [];
    let lines = this.sourceLines.get(source.file);
    if (!lines) {
      const text = this.sources.get(source.file);
      if (text === undefined) return [];
      lines = text.split(/\r\n|\n|\r/);
      this.sourceLines.set(source.file, lines);
    }
    const line = lines[source.line - 1];
    if (line === undefined) return [];
    // We have the target source line that threw the error, so build the
    // ^ caret pointing at the right location in the source line.
    const gutter = String(source.line);
    // Copy tabs into the caret row so the marker lines up under any indentation.
    const indent = line.substring(0, Math.min(source.column, line.length)).replace(/[^\t]/g, ' ');
    return [
      ` ${gutter} | ${line}`,
      ` ${' '.repeat(gutter.length)} | ${indent}^`,
    ];
  }

  /**
   * Prints one diagnostic in the following format:
   *
   *     file.s:12:8: error: Expected identifier
   *      12 |   lda #$ff,
   *         |            ^
   *     file.s:3:1: note: expanded from here
   */
  private printDiagnostic(level: Tokens.ErrorLevel, message: string, source?: Tokens.SourceInfo) {
    const label = level === 'info' ? 'note' : level;
    console.log(`${this.locationPrefix(source)}${label}: ${message}`);
    for (const line of this.snippet(source)) console.log(line);
    // Walk the include / macro-expansion stack outwards.
    for (let p = source?.parent; p; p = p.parent) {
      console.log(`${this.locationPrefix(p)}note: expanded from here`);
      for (const line of this.snippet(p)) console.log(line);
    }
  }

  printerrors(...err: Error[]) {
    for (const e of err) {
      this.printDiagnostic('error', e.message,
                           e instanceof Tokens.SourceError ? e.source : undefined);
    }
    this.printSummary(err.length, 0);
  }

  printMessages(messages: Tokens.AssemblerMessage[]) {
    for (const msg of messages) {
      this.printDiagnostic(msg.level, msg.message, msg.source);
    }
    this.printSummary(messages.filter(m => m.level === 'error').length,
                      messages.filter(m => m.level === 'warning').length);
  }

  private printSummary(errorCount: number, warningCount: number) {
    const parts = [];
    if (errorCount > 0) parts.push(`${errorCount} error${errorCount !== 1 ? 's' : ''}`);
    if (warningCount > 0) parts.push(`${warningCount} warning${warningCount !== 1 ? 's' : ''}`);
    if (parts.length) console.log(`${parts.join(', ')} generated.`);
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
  -m FILE/--mapfile=FILE  Output a linker map (free space / placed chunks) to the specified file. Cannot be used with --compileonly.
  -C FILE/--config=FILE   Link using an ld65 linker config, in place of the built-in
                          segment layout.
                          Cannot be used with --compileonly.
  -I DIR/--include-dir=DIR
                          Add DIR to the \`.include\` search path. Directories are
                          searched in the order given, after the directory of the file doing the
                          including and the directories of the input files. Repeatable.
  --bin-include-dir=DIR   Add DIR to the \`.incbin\` search path. If none are given,
                          \`.incbin\` falls back to the -I directories. Repeatable.
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
