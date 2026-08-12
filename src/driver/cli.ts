
// SPDX-License-Identifier: MPL-2.0

import { Cpu } from '../cpu.ts';
import { clean, smudge } from '../smudge.ts';
import { createHash } from "sha1-uint8array";
import { Base64 } from '../base64.ts';
import { compile, type AssemblyInput, type Js65Options } from '../libassembler.ts';
import * as Tokens from '../token.ts';
import { LINT_RULES } from '../lint.ts';
import { dirOf, joinDir } from '../util.ts';
import { VERSION } from '../version.ts';
import { Builder, BuildSession, selectProjects, STDIN, STDOUT,
         type BuildOverrides } from './build.ts';
import { walkFiles, type Callbacks } from './fs.ts';
import { init as scaffoldProject, DEFAULT_TARGET } from './init.ts';
import { parseProject, type Js65Config, type Js65Project } from './project.ts';

// Re-exported so `js65/cli` consumers and the frontends keep a single import site.
export { type Callbacks } from './fs.ts';

export interface CompileOptions {
  files: string[],
  outfile?: string,
}

export interface HydrateOptions {
  rom?: string,
  file?: string,
}

class Arguments {
  help = false;
  version = false;
  outfile = "";
  op: ((src: string, cpu: Cpu, prg: Uint8Array) => string) | undefined = undefined;
  rom = "";
  files : string[] = [];
  dbgfile = "";
  mapfile = "";
  cfgfile = "";
  depfile = "";
  projectFile = "";
  force = false;
  compileonly = false;
  patch : "ips" | "" = "";
  options: Js65Options = {
    includePaths: [],
    binIncludePaths: [],
    defines: [],
    features: [],
    lineContinuations: true,
    debugLevel: 0, // -1 = disabled, 0 = comments/labels only, 1 = full source
    generateDebugInfo: true,
    lint: {rules: {}},
  };
}

const DEPFILE_FLAGS = ['--create-dep', '--create-full-dep', '--create-deps'];

const RE_SYMBOL_NAME = /^[a-z_][a-z0-9_]*$/i;

interface Option {
  /** various accepted spellings for the option */
  names: string[];
  /** number of parameters this takes in */
  arity: 0 | 1;
  /** Allows the value to be glued onto a short name like `-Iinc` */
  attached?: boolean;
  /** function called to write the option when found */
  apply(this: Cli, out: Arguments, value: string): void;
}

/** wraps an apply function to keep it from getting called multiple times */
function once(get: (out: Arguments) => string,
              set: (out: Arguments, value: string) => void) {
  return function(this: Cli, out: Arguments, value: string) {
    if (get(out)) this.usage();
    set(out, value);
  };
}

const OPTIONS: Option[] = [
  {names: ['-h', '--help'], arity: 0,
   apply(out) { out.help = true; }},
  {names: ['-V', '--version'], arity: 0,
   apply(out) { out.version = true; }},
  {names: ['-o', '--outfile', '--output'], arity: 1,
   apply: once(out => out.outfile, (out, v) => { out.outfile = v; })},
  {names: ['--dbgfile'], arity: 1,
   apply: once(out => out.dbgfile, (out, v) => { out.dbgfile = v; })},
  {names: ['-m', '--mapfile'], arity: 1,
   apply: once(out => out.mapfile, (out, v) => { out.mapfile = v; })},
  {names: DEPFILE_FLAGS, arity: 1,
   apply: once(out => out.depfile, (out, v) => { out.depfile = v; })},
  {names: ['-C', '--config'], arity: 1,
   apply: once(out => out.cfgfile, (out, v) => { out.cfgfile = v; })},
  {names: ['-p', '--project'], arity: 1,
   apply: once(out => out.projectFile, (out, v) => { out.projectFile = v; })},
  {names: ['--force'], arity: 0,
   apply(out) { out.force = true; }},
  {names: ['-g', '-g0'], arity: 0,
   apply(out) {
     out.options.debugLevel = 0; // Comments and labels only
     out.options.generateDebugInfo = true;
   }},
  {names: ['-g1'], arity: 0,
   apply(out) {
     out.options.debugLevel = 1; // Full source code
     out.options.generateDebugInfo = true;
   }},
  {names: ['--no-debuginfo'], arity: 0,
   apply(out) {
     out.options.debugLevel = -1; // Disable debug info generation
     out.options.generateDebugInfo = false;
   }},
  {names: ['-c', '--compileonly'], arity: 0,
   apply(out) {
     out.compileonly = true;
     out.options.outputFormat = 'object';
   }},
  {names: ['--stdin'], arity: 0,
   apply(out) { out.files.push(Cli.STDIN); }},
  {names: ['-r', '--rom'], arity: 1,
   apply(out, value) { out.rom = value; }},
  {names: ['--bin-include-dir'], arity: 1,
   apply(out, value) { out.options.binIncludePaths!.push(value); }},
  // `--asm-include-dir` is slightly different from -I but i don't see why it matters
  {names: ['-I', '--include-dir', '--asm-include-dir'], arity: 1, attached: true,
   apply(out, value) { out.options.includePaths!.push(value); }},
  {names: ['--ips'], arity: 0,
   apply(out) {
     out.patch = 'ips';
     out.options.outputFormat = 'ips';
   }},
  {names: ['-t', '--target'], arity: 1, attached: true,
   apply(out, value) { out.options.target = value; }},
  // We don't lazy load modules right now so forceimport is a no-op
  {names: ['-u', '--force-import'], arity: 1, attached: true,
   apply() {}},
  {names: ['-D', '--define'], arity: 1, attached: true,
   apply(out, value) {
     const eq = value.indexOf('=');
     const name = eq < 0 ? value : value.substring(0, eq);
     if (!RE_SYMBOL_NAME.test(name)) {
       this.usage(1, [new Error(`Invalid symbol name for -D: '${name}'`)]);
       return;
     }
     out.options.defines!.push(
         {name, value: eq < 0 ? '1' : value.substring(eq + 1)});
   }},
  {names: ['--feature'], arity: 1,
   apply(out, value) {
     // Features can be comma separated too so we need to comma split here
     for (const name of value.split(',')) {
       out.options.features!.push(name.trim());
     }
   }},
  {names: ['--no-lint'], arity: 0,
   apply(out) { out.options.lint!.enabled = false; }},
  {names: ['-W'], arity: 1, attached: true,
   apply(out, value) {
     const rule = value.startsWith('no-') ? value.substring(3) : '';
     if (!LINT_RULES.has(rule)) {
       const known = [...LINT_RULES.keys()].join(', ');
       this.usage(1, [new Error(
           `Invalid -W option: '-W${value}'. Expected -Wno-<rule>, where ` +
           `<rule> is one of: ${known}`)]);
       return;
     }
     out.options.lint!.rules![rule] = 'off';
   }},
];

/** The positional subcommands, which are words rather than flags. */
const SUBCOMMANDS = new Map<string, (src: string, cpu: Cpu, prg: Uint8Array) => string>([
  ['rehydrate', smudge],
  ['dehydrate', clean],
]);

/**
 * The options `js65 build` takes, named by each option's first spelling. Everything else
 * in OPTIONS describes a single assembly, which is `js65.json`'s job in a build, so
 * giving one is an error rather than something quietly ignored.
 */
const BUILD_OPTIONS = new Set([
  '-h', '-V', '-p', '-o', '--dbgfile', '-m', DEPFILE_FLAGS[0], '-I',
  '--bin-include-dir', '-D', '--feature', '--no-lint', '-W',
]);

/** The options `js65 init` takes. Scaffolding a folder needs almost nothing. */
const INIT_OPTIONS = new Set(['-h', '-V', '-t', '--force']);

// const DEBUG_PRINT = false;

// const DEBUG = (...args : any) => {
//   if (DEBUG_PRINT) {
//     console.log(args);
//   }
// }

export class Cli {
  public static readonly STDIN : string = STDIN;
  public static readonly STDOUT : string = STDOUT;

  /** State of the build in progress: source cache, dep list, output writing. */
  private readonly session: BuildSession;

  constructor(readonly callbacks: Callbacks) {
    this.callbacks = callbacks;
    this.session = new BuildSession(callbacks);
  }

  private matchOption(arg: string): {option: Option, value?: string} | undefined {
    for (const option of OPTIONS) {
      for (const name of option.names) {
        if (arg === name) return {option};
        if (option.arity === 0) continue;
        if (arg.startsWith(`${name}=`)) {
          return {option, value: arg.substring(name.length + 1)};
        }
        if (option.attached && arg.length > name.length && arg.startsWith(name)) {
          return {option, value: arg.substring(name.length)};
        }
      }
    }
    return undefined;
  }

  parseArgs(args : string[]) : Arguments {
    const out = new Arguments();
    // `--` sets the rest of the command line to be filenames only
    let filesOnly = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (!filesOnly && arg === '--') {
        filesOnly = true;
        continue;
      }
      const match = filesOnly ? undefined : this.matchOption(arg);
      if (match) {
        const {option} = match;
        // An `--x VAL` option takes the next argument; the `--x=VAL` and
        // `-xVAL` spellings carried their value in with them.
        const value = option.arity === 0 ? arg
            : match.value ?? args[++i];
        option.apply.call(this, out, value);
      } else if (!filesOnly && SUBCOMMANDS.has(arg)) {
        out.op = SUBCOMMANDS.get(arg);
      } else if (!filesOnly && arg.length > 1 && arg.startsWith('-')) {
        this.usage(1, [new Error(`Unknown option: ${arg}`)]);
      } else {
        out.files.push(arg);
      }
    }
    return out;
  }

  public async run(argv: string[]) {
    // `build` and `init` take different flag sets than an assembly does, so they are
    // dispatched on before the arguments are parsed rather than picked out of the
    // positionals after.
    if (argv[0] === 'build') return this.build(argv.slice(1));
    if (argv[0] === 'init') return this.init(argv.slice(1));

    const args = this.parseArgs(argv);
    if (args.projectFile) {
      return this.usage(8, [new Error(
          '-p/--project only applies to `js65 build`')]);
    }
    if (args.force) {
      return this.usage(8, [new Error('--force only applies to `js65 init`')]);
    }
    if (args.version) {
      console.log(`js65 ${VERSION}`);
      return this.callbacks.exit(0);
    }

    if (args.help) {
      return this.usage(0);
    }

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

    // The dependency file names the output as its make target, and `//stdout` is not
    // something make can build.
    if (args.depfile && (args.outfile === "--stdout" || args.outfile === Cli.STDOUT)) {
      return this.usage(8, [new Error("Cannot use --create-dep flag combined with -o --stdout")]);
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
        inputs.push(await this.session.readInput(file));
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
        args.options.linkerConfig = await this.session.readSource("", args.cfgfile);
        args.options.linkerConfigName = args.cfgfile;
      }

      // Load base ROM if specified
      let baseRom: Uint8Array | undefined;
      if (args.rom) {
        let romData = await this.session.readBinary("", args.rom);
        if (typeof romData === "string") romData = new Base64().decode(romData);
        baseRom = romData;
      }

      const result =
          await compile(inputs, args.options, this.session.fileCallbacks, baseRom);

      if (result.messages.length > 0) {
        this.printMessages(result.messages);
      }

      if (!result.success) {
        this.callbacks.exit(1);
        return;
      }

      await this.session.writeOutputs(result, {
        outfile: args.outfile,
        dbgfile: args.dbgfile,
        mapfile: args.mapfile,
        depfile: args.depfile,
      });
    } catch (e) {
      this.printerrors(e as Error);
      throw e;
    }
  }

  /**
   * `js65 build [PROJECT...]` - assemble and link every project in `js65.json`, or just
   * the named ones.
   */
  private async build(argv: string[]) {
    const rejected = this.rejectOptions(argv, BUILD_OPTIONS, 'build');
    if (rejected) return this.buildUsage(8, [rejected]);
    const args = this.parseArgs(argv);
    if (args.version) {
      console.log(`js65 ${VERSION}`);
      return this.callbacks.exit(0);
    }
    if (args.help) return this.buildUsage(0);

    // No walking up to find the project file: the frontends have no cwd of their own and
    // no way to recognize the filesystem root, so `build` runs from the project root or
    // is pointed at one with -p.
    const projectFile = args.projectFile || 'js65.json';
    let config: Js65Config;
    let selected: Js65Project[];
    try {
      config = parseProject(
          projectFile, await this.callbacks.fsReadString("", projectFile));
    } catch (e) {
      this.printerrors(e as Error);
      return this.callbacks.exit(1);
    }
    try {
      selected = selectProjects(config, args.files);
    } catch (e) {
      return this.buildUsage(8, [e as Error]);
    }

    // These name one file each. Against several projects they would either be
    // meaningless or let one project clobber another's output, so say so instead.
    const single = ([['-o', args.outfile], ['--dbgfile', args.dbgfile],
                     ['-m', args.mapfile], [DEPFILE_FLAGS[0], args.depfile]] as const)
        .find(([, value]) => value);
    if (single && selected.length !== 1) {
      return this.buildUsage(8, [new Error(
          `${single[0]} names a single file, but ${selected.length} projects are ` +
          `selected. Name one project, or set the output in ${projectFile}.`)]);
    }

    const overrides: BuildOverrides = {
      includePaths: args.options.includePaths,
      binIncludePaths: args.options.binIncludePaths,
      defines: args.options.defines,
      features: args.options.features,
      lint: args.options.lint,
      outfile: args.outfile || undefined,
      dbgfile: args.dbgfile || undefined,
      mapfile: args.mapfile || undefined,
      depfile: args.depfile || undefined,
    };
    const builder = new Builder(this.session, {
      messages: messages => this.printMessages(messages),
      log: line => console.log(line),
    });
    const result = await builder.build(config, selected, overrides);
    // Only on failure: a host whose exit() really does exit would kill a successful run
    // before its caller could clean up.
    if (!result.success) this.callbacks.exit(1);
  }

  /**
   * `js65 init [NAME]` - write out a project that builds as it stands.
   */
  private async init(argv: string[]) {
    const rejected = this.rejectOptions(argv, INIT_OPTIONS, 'init');
    if (rejected) return this.initUsage(8, [rejected]);
    const args = this.parseArgs(argv);
    if (args.version) {
      console.log(`js65 ${VERSION}`);
      return this.callbacks.exit(0);
    }
    if (args.help) return this.initUsage(0);
    if (args.files.length > 1) {
      return this.initUsage(8, [new Error(
          `js65 init takes at most one directory name, got ${args.files.length}`)]);
    }

    try {
      const result = await scaffoldProject(this.callbacks, {
        dir: args.files[0],
        target: args.options.target,
        force: args.force,
      });
      console.log(`js65: created project "${result.name}" in ${result.dir || '.'}`);
      for (const file of result.files) console.log(`  ${joinDir(result.dir, file)}`);
      console.log(result.dir ? `Build it with: cd ${result.dir} && js65 build`
                             : 'Build it with: js65 build');
    } catch (e) {
      // A directory that already holds a project, or a target that does not exist.
      this.printerrors(e as Error);
      return this.callbacks.exit(1);
    }
  }

  /** The first option in `argv` that the named subcommand does not accept. */
  private rejectOptions(argv: string[], allowed: ReadonlySet<string>,
                        command: string): Error | undefined {
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--') break;
      const match = this.matchOption(argv[i]);
      if (!match) continue;
      // Step over a value given as a separate argument so `-o -m` can't misread `-m`.
      if (match.option.arity === 1 && match.value === undefined) i++;
      const name = match.option.names[0];
      if (!allowed.has(name)) {
        return new Error(`${name} cannot be used with \`js65 ${command}\``);
      }
    }
    return undefined;
  }

  async smudge(args: Arguments) {
    // `usage` reports and asks the host to exit, but it cannot stop this function - a
    // host whose exit() merely records the code (node sets process.exitCode) keeps
    // running, so every check has to return rather than fall through to the deref below.
    if (args.files.length > 1) {
      return this.usage(1, [new Error('rehydrate and dehydrate only allow one input')]);
    }
    const src = await this.callbacks.fsReadString("",args.files[0]);
    // if (err) this.usage(3, [err]);
    let fullRom: Uint8Array|undefined = undefined;
    if (args.rom) {
      let inbytes = await this.callbacks.fsReadBytes("",args.rom);
      fullRom = (typeof inbytes === 'string') ? new Base64().decode(inbytes) : inbytes;
      // if (err) this.usage(4, [err]);
    } else {
      // exec() yields null, not undefined, so this has to be a nullish check.
      const match = /smudge sha1 ([0-9a-f]{40})/.exec(src!);
      if (!match) return this.usage(1, [new Error('no sha1 tag, must specify rom')]);
      const shaTag = match[1];
      await walkFiles(this.callbacks, '.', async(filename) => {
        if (/\.nes$/.test(filename)) {
          let inbytes = await this.callbacks.fsReadBytes("",filename);
          inbytes = (typeof inbytes === 'string') ? new Base64().decode(inbytes) : inbytes;

          // if (err) this.usage(5, [err]);
          const sha = Array.from(
              new Uint8Array(createHash().update(inbytes!).digest()),
              x => x.toString(16).padStart(2, '0')).join('');
          if (sha === shaTag) {
            fullRom = Uint8Array.from(inbytes!);
            return true;
          }
        }
        return false;
      }
      );
      if (!fullRom) {
        return this.usage(1, [new Error(`could not find rom with sha ${shaTag}`)]);
      }
    }

    // TODO - read the header properly
    const prg = (fullRom as Uint8Array).subarray(0x10, 0x40010);
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
    const line = this.session.sourceLine(source.file, source.line);
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
  private printDiagnostic(level: Tokens.ErrorLevel, message: string,
                          source?: Tokens.SourceInfo, code?: string) {
    const label = level === 'info' ? 'note' : level;
    const tag = code ? ` [${code}]` : '';
    console.log(`${this.locationPrefix(source)}${label}: ${message}${tag}`);
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
    for (const msg of Tokens.sortByLocation(messages)) {
      this.printDiagnostic(msg.level, msg.message, msg.source, msg.code);
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

  public buildUsage(code = 1, err: Error[]|undefined = undefined) {
    if (err) this.printerrors(...err);
    console.log(`\
Usage: js65 build [options] [PROJECT...]
  Assembles and links every project described by a js65.json, or only the named
  ones. Each project is built in this one process, so nothing round-trips through
  a .o file on disk. A project that fails does not stop the others.

positional arguments:
  PROJECT[...]            Name of a project in the file. If none are given, every
                          project in the file is built.

optional arguments:
  -p FILE/--project=FILE  The project file to read. Default \`js65.json\` in the
                          current directory; js65 does not search parent directories.
  -o FILE/--output=FILE   Write the linked output here, in place of the project's
                          own \`output\`. Only valid when one project is selected.
  --dbgfile FILE          Write debug symbols here, in place of the project's \`dbgfile\`.
                          Only valid when one project is selected.
  -m FILE/--mapfile=FILE  Write the linker map here, in place of the project's
                          \`mapfile\`. Only valid when one project is selected.
  --create-dep FILE       Write a make dependency file for the selected project.
                          Only valid when one project is selected.
  -I DIR/--include-dir=DIR
                          Search DIR for \`.include\` as well, after the project's own
                          \`includePaths\`. Applies to every selected project. Repeatable.
  --bin-include-dir=DIR   The same, for \`.incbin\` and \`binIncludePaths\`.
  -D NAME[=VALUE]/--define=NAME[=VALUE]
                          Define NAME for every selected project, overriding a
                          \`defines\` entry of the same name. Repeatable.
  --feature NAME[,NAME]   Enable a feature for every selected project. Repeatable.
  --no-lint               Turn off every lint, whatever the project file's \`lint\` says.
  -Wno-RULE               Turn off a single lint rule. Repeatable.
  -h/--help               Print this help text and exit.

Exits 0 when every selected project built, 1 when any of them failed, and 8 for a
bad command line.
`);
    this.callbacks.exit(code);
  }

  public initUsage(code = 1, err: Error[]|undefined = undefined) {
    if (err) this.printerrors(...err);
    console.log(`\
Usage: js65 init [options] [NAME]
  Writes a project that builds as it stands: a js65.json, a src/main.s holding an
  iNES header and a reset routine, an inc/ with the hardware registers in it, and
  an assets/ for tile data. \`js65 build\` in the new directory produces a ROM with
  no edits.

positional arguments:
  NAME                    Directory to create, and the name of the project in it.
                          If none is given, the current directory is scaffolded and
                          the project is named \`main\`.

optional arguments:
  -t NAME/--target=NAME   Built-in segment layout the generated project links with.
                          Default \`${DEFAULT_TARGET}\`.
  --force                 Scaffold even when the directory already holds files,
                          overwriting any that collide. Without it, js65 refuses
                          unless the directory is absent or holds only dot entries
                          such as \`.git\`.
  -h/--help               Print this help text and exit.
`);
    this.callbacks.exit(code);
  }

  public usage(code = 1, err: Error[]|undefined = undefined) {
    if (err) this.printerrors(...err);
    console.log(`\
Usage: js65 [options] FILE[...]
  Assembles and links all files into output
Usage: js65 init [NAME]
  Creates a project that builds as it stands. See \`js65 init --help\`.
Usage: js65 build [options] [PROJECT...]
  Builds the projects described by a js65.json. See \`js65 build --help\`.
Usage: js65 rehydrate|dehydrate -r|--rom=<rom> FILE
  Remove/Re-add data in an assembly file from the original ROM.

## Assembler Options:

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
  --create-dep FILE       Write a make dependency file listing every source, \`.include\` and
                          \`.incbin\` the build read, with the output file as the target.
                          \`-include\` it from a Makefile so edits to a header rebuild the object.
                          Cannot be used with --stdout. \`--create-full-dep\` and
                          \`--create-deps\` are accepted as aliases for ca65 compat.
  -C FILE/--config=FILE   Link using an ld65 linker config, in place of the built-in
                          segment layout.
                          Cannot be used with --compileonly.
  -I DIR/--include-dir=DIR
                          Add DIR to the \`.include\` search path. Directories are
                          searched in the order given, after the directory of the file doing the
                          including and the directories of the input files. Repeatable.
                          \`--asm-include-dir\` is accepted as an alias for cc65 compat.
  --bin-include-dir=DIR   Add DIR to the \`.incbin\` search path. If none are given,
                          \`.incbin\` falls back to the -I directories. Repeatable.
  -D NAME[=VALUE]/--define=NAME[=VALUE]
                          Define NAME before any source is read. VALUE defaults to 1.
                          Accepts numeric values (binary, decimal, hexidecimal) as if they
                          were created as \`NAME .set VALUE\`
                          EX: -D FOO=1 -DFOO -DFOO=$1f -DFOO=%1010
                          Also accepts other values such as strings or expressions as if they
                          were created as \`.define NAME VALUE\` just like how C compilers
                          treat the option. Repeatable.
                          EX: -DFOO=bar -DFOO= -D FOO=3+5
  --feature NAME[,NAME]   Enable a feature before any source is read, as if the
                          file started with \`.feature NAME\`. Takes a comma separated
                          list. Repeatable.
                          EX: --feature c_comments --feature pc_assignment,force_range
  --no-lint               Turn off every lint. Lints are warnings/notes about code that
                          assembles cleanly but probably isn't what was meant; they never
                          fail the build.
  -Wno-RULE               Turn off a single lint rule. Repeatable. Rules:
${[...LINT_RULES].map(([id, r]) => `                            ${id.padEnd(24)}${r.description}`).join('\n')}
                          A single line can also be exempted from the source with a
                          \`; js65-lint-disable-next-line RULE\` or
                          \`; js65-lint-disable-line RULE\` comment.
  -t NAME/--target=NAME   Link with a built-in segment layout instead of a linker config.
                          js65 has two: \`sim\` and \`nes-nrom\`.
                          Ignored when a config is given with -C.
  -u SYM/--force-import=SYM
                          Accepted and ignored, for ld65 compat. js65 links every module it
                          is given in full, so no import needs forcing.
  -h/--help               Print this help text and exit.
  -V/--version            Print the js65 version and exit.
  --                      Ends the option list. Everything after this will be parsed as an input file.

## Hydrate Options:
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
