
// SPDX-License-Identifier: MPL-2.0

/**
 * Lib assembler is the entry point for the general "compile" tasks for your project.
 * If you are wanting to use js65 like a library, this is where you can look.
 * 
 * Typically if you want to build something, and you have the ability to write generic
 * javascript objects, you can use the `compile` function. If you need to pass in a whole
 * list of commands as data to process, then the `AssemblyAction` approach is what you want.
 * Using the `AssemblyAction` tree, you can build a data oriented list of commands to run,
 * which programtically drives the internal assemble/link options for you. Then you don't
 * need to figure out how to get your data into the object format that js65 needs, you can
 * just serialize basic JSON objects. (This is the approach the C# desktop integration uses)
 * 
 * The CLI and Language Server all go through the entrypoints in this file, so its a bit
 * crowded, but you have free reign to do what you need.
 */

import { Assembler } from './assembler.ts';
import { Base64 } from './base64.ts';
import { Cpu } from './cpu.ts';
import { Linker } from './linker.ts';
import { Preprocessor } from './preprocessor.ts';
import { Tokenizer } from './tokenizer.ts';
import { applyFeatures,
         type AssemblerOptions as AsmOptions,
         type LintOptions,
         type SymbolDefine,
         type TokenizerOptions } from './options.ts';
import { LintPragmas } from './lint.ts';
import * as Tokens from './token.ts';
import { TokenStream, SourceContents } from './tokenstream.ts';
import { type Module, type Segment } from "./module.ts";
import { parseModule, parseRequest } from "./validate_modules.ts";
import * as Exprs from './expr.ts';
import type { Expr } from './expr.ts';
import { MaxKeySizeCacheMap } from './util.ts';
import { ErrorCollector, SourceError, type SourceInfo, type AssemblerMessage } from './error.ts';
import type { MacroIndex, SymbolIndex } from './lspindex.ts';
import { gzipCodec } from './driver/codec/codec.ts';

// Re-export Assembler for direct programmatic use
export { Assembler, Cpu, SourceContents, Base64 };
export type { Expr, Module, Segment, SymbolDefine, SymbolIndex };

// Builder API for using js65 with a fluent API instead of needing to understand the internals.
export { AsmEngine, AsmModule, sym } from './builder.ts';

/** Source location for an action (from the caller's code) */
export interface ActionSource {
  file: string;
  line: number;
}

/**
 * Action types for programmatic assembly
 */
export type AssemblyAction =
  | { action: 'code', code: string, name?: string, source?: ActionSource }
  | { action: 'label', label: string, source?: ActionSource }
  | { action: 'byte', bytes: Array<number | string | { op: 'sym', sym: string }>, source?: ActionSource }
  | { action: 'word', words: Array<number | { op: 'sym', sym: string }>, source?: ActionSource }
  | { action: 'hibytes', values: Array<number | { op: 'sym', sym: string }>, source?: ActionSource }
  | { action: 'lobytes', values: Array<number | { op: 'sym', sym: string }>, source?: ActionSource }
  | { action: 'literal', values: Array<number | string | { op: 'sym', sym: string }>, source?: ActionSource }
  | { action: 'org', addr: number, name?: string, source?: ActionSource }
  | { action: 'segment', name: string | string[], source?: ActionSource }
  | { action: 'reloc', name?: string, source?: ActionSource }
  | { action: 'export', name: string, source?: ActionSource }
  | { action: 'exportzp', names: string[], source?: ActionSource }
  | { action: 'import', names: string[], source?: ActionSource }
  | { action: 'importzp', names: string[], source?: ActionSource }
  | { action: 'global', names: string[], source?: ActionSource }
  | { action: 'globalzp', names: string[], source?: ActionSource }
  | { action: 'assign', name: string, value: number | string, source?: ActionSource }
  | { action: 'set', name: string, value: number | string, source?: ActionSource }
  | { action: 'free', size: number, source?: ActionSource }
  | { action: 'align', boundary: number, fill?: number, source?: ActionSource }
  | { action: 'res', count: number, value?: number, source?: ActionSource }
  | { action: 'charmap', code: number, target: number, source?: ActionSource }
  | { action: 'strmap', key: string, bytes: number[], source?: ActionSource }
  | { action: 'pushcharmap', source?: ActionSource }
  | { action: 'popcharmap', source?: ActionSource };

/**
 * Assembly input - supports source code, pre-compiled modules, or a list of
 * programmatic actions (a way to build a module without writing source text).
 */
export type AssemblyInput =
  | { type: 'source', code: string, name: string }
  | { type: 'module', module: Module }
  | { type: 'actions', actions: AssemblyAction[], name?: string };

/**
 * Cooperative cancellation primitive. Designed to look like AbortSignal so it can be used
 * in environments that have it and in envs that don't.
 */
export type CancelSignal = { readonly aborted: boolean };

function throwIfCancelled(signal?: CancelSignal): void {
  if (signal?.aborted) throw new Error('Compilation cancelled');
}

/**
 * Options specifically for assembly phase.
 * This is usually built by `compile` for you unless you want to compile to module directly. 
 */
export interface AssemblerOptions {
  includePaths?: string[];
  binIncludePaths?: string[];
  generateDebugInfo?: boolean;
  defines?: SymbolDefine[];
  features?: string[];

  lineContinuations?: boolean;
  numberSeparators?: boolean;
  cComments?: boolean;
  allowBrackets?: boolean;
  labelsWithoutColons?: boolean;
  pcAssignment?: boolean;
  forceRange?: boolean;
  leadingDotInIdentifiers?: boolean;
  /** If true, then gather all the sym refs and defines for the LSP */
  collectReferences?: boolean;
  /** Cache of all symbols for the LSP. not used unless collectReferences is on */
  symbolIndex?: SymbolIndex;
  /** Cache of all the macros/defines for the LSP */
  macroIndex?: MacroIndex;
  errorLimit?: number;
  /** Lint rule configuration. Lints run by default. */
  lint?: LintOptions;
}

/**
 * Options specifically for linking phase.
 * This is usually built by `compile` for you unless you want link separately.
 */
export interface LinkerOptions {
  target?: string;
  baseRom?: Uint8Array;
  baseRomOffset?: number;
  /** Full text of an ld65 linker config, which replaces `target`. */
  linkerConfig?: string;
  /** Name to report `linkerConfig` parse errors against. */
  linkerConfigName?: string;
  /** -D define values from the CLI, but only the numeric ones for the linker */
  defines?: SymbolDefine[];
  /** Debug level for debug info generation:
   * -1 = disabled
   *  0 = comments/labels only
   *  1 = full source
   *  2 = full source + file:line location suffix
   */
  debugLevel?: number;
  /** Emit a linker map (free space / placed chunks report) as a sidecar output. */
  generateMapFile?: boolean;
}

/** Output format control */
export type OutputFormat = 'binary' | 'ips' | 'object';

/**
 * All of the options that the internal tasks like assemble and link support.
 * Each option matches with a similarly named CLI option, so check there for docs.
 */
export interface Js65Options {
  includePaths?: string[];
  binIncludePaths?: string[];
  generateDebugInfo?: boolean;

  lineContinuations?: boolean;
  numberSeparators?: boolean;
  cComments?: boolean;
  allowBrackets?: boolean;
  labelsWithoutColons?: boolean;
  pcAssignment?: boolean;
  forceRange?: boolean;
  leadingDotInIdentifiers?: boolean;
  debugLevel?: number;
  target?: string;
  baseRomOffset?: number;
  outputFormat?: OutputFormat;
  generateMapFile?: boolean;
  /** Full text of an ld65 linker config. Replaces `target` when given. */
  linkerConfig?: string;
  /** Name to report `linkerConfig` parse errors against. */
  linkerConfigName?: string;
  /** `-D` defines. will be parsed into .set values or .define macros later */
  defines?: SymbolDefine[];
  /** features passed in through --feature */
  features?: string[];
  /** lint configuration, from `--no-lint` / `-Wno-<rule>` or a project file */
  lint?: LintOptions;
}

/**
 * Contains the post-validated data used for compilation.
 * This is a validated list of processing commands, you don't need to use this usualy.
 */
export interface Js65Request {
  inputs: AssemblyInput[];
  options: Js65Options;
}

/**
 * The kind of artifact an OutputFile holds.
 * If more output types are created, we'll add them to the end here
 *   - 'binary' : a linked ROM image or IPS patch
 *   - 'object' : a serialized .o module
 *   - 'debug'  : debug info (currently MLB labels)
 *   - 'source' : generated source text
 *   - 'map'    : linker map (free space / placed chunks report)
 */
export type OutputType = 'source' | 'binary' | 'object' | 'debug' | 'map';

/** One named output produced by a compile. */
export interface OutputFile {
  name: string;
  data: Uint8Array;
  type: OutputType;
}

/**
 * File system callbacks for .include/.incbin directives
 */
export interface FileCallbacks {
  readText: (path: string, filename: string) => Promise<string>;
  readBinary: (path: string, filename: string) => Promise<Uint8Array | string>;
}

/** Result type for assemble that includes collected messages */
export interface AssembleResult {
  /** Whether assembly succeeded (no errors) */
  success: boolean;
  /** Compiled modules */
  modules: Module[];
  /** All messages (errors, warnings, info) from assembly */
  messages: AssemblerMessage[];
}

// Helper to convert ActionSource to SourceInfo
function toSourceInfo(source?: ActionSource): SourceInfo | undefined {
  if (!source) return undefined;
  return { file: source.file, line: source.line, column: 0 };
}

function toValueExpr(v: number | { op: 'sym', sym: string }): Expr {
  return typeof v === 'number' ? { op: 'num', num: v } : v;
}

async function applyDefines(asm: Assembler, pre: Preprocessor,
                            defines: SymbolDefine[] | undefined,
                            opts: TokenizerOptions) {
  for (const {name, value} of defines ?? []) {
    const toks = await new Tokenizer(value, '<command line>', opts).next() ?? [];
    // Drop the trailing EOL the tokenizer appends so a lone number is length 1.
    const body = toks.length && Tokens.eq(toks[toks.length - 1], Tokens.EOL)
        ? toks.slice(0, -1) : toks;
    if (body.length === 1 && body[0].token === 'num') {
      asm.commandLineSet(name, body[0].num);
      continue;
    }
    if (!body.length) {
      // `-D FOO=` with an empty value expands to nothing like CPP would do
      await pre.parseDefine([Tokens.DEFINE, {token: 'ident', str: name}]);
      continue;
    }
    await pre.parseDefine([Tokens.DEFINE, {token: 'ident', str: name}, ...body]);
  }
}

/**
 * Assembles source files, pre-compiled modules, and/or action lists into
 * Module objects. This is like running with `-c` to compile only
 *
 * @param inputs - Array of source code, modules, or action lists to assemble
 * @param options - Assembler configuration
 * @param callbacks - File system callbacks for .include/.incbin
 * @param sourceContents - Optional SourceContents to store source for debug info
 * @returns Array of compiled Module objects and any messages
 */
export async function assemble(
  inputs: AssemblyInput[],
  options?: AssemblerOptions,
  callbacks?: FileCallbacks,
  sourceContents?: SourceContents,
  signal?: CancelSignal
): Promise<AssembleResult> {
  const modules: Module[] = [];
  const allMessages: AssemblerMessage[] = [];

  const baseOpts: TokenizerOptions = {
    includePaths: options?.includePaths || [],
    binIncludePaths: options?.binIncludePaths,
    generateDebugInfo: options?.generateDebugInfo,
    lineContinuations: options?.lineContinuations ?? true,
    numberSeparators: options?.numberSeparators,
    cComments: options?.cComments,
    leadingDotInIdentifiers: options?.leadingDotInIdentifiers,
    // One shared instance: pragmas are keyed by file, and every module's
    // tokenizer records into the same table the linter later consults.
    lintPragmas: options?.lint?.enabled === false ? undefined : new LintPragmas(),
  };
  const baseAsmOpts: AsmOptions = {
    generateDebugInfo: options?.generateDebugInfo,
    allowBrackets: options?.allowBrackets,
    labelsWithoutColons: options?.labelsWithoutColons,
    pcAssignment: options?.pcAssignment,
    forceRange: options?.forceRange,
    collectReferences: options?.collectReferences,
    symbolIndex: options?.symbolIndex,
    errorLimit: options?.errorLimit,
    lint: options?.lint,
  };
  const featureMessages = applyFeatures(options?.features ?? [], baseAsmOpts, baseOpts);
  allMessages.push(...featureMessages);
  if (featureMessages.some(m => m.level === 'error')) {
    return { success: false, modules, messages: allMessages };
  }
  /**
   * Set up the options so that the same TokenizerOptions object is passed to all preprocessor instances
   * This is needed to keep midmodule `.feature` changes rolling down through `.include`d files
   */
  function moduleOpts(moduleName: string): {opts: TokenizerOptions, asmOpts: AsmOptions} {
    const opts = {...baseOpts};
    return {opts, asmOpts: {...baseAsmOpts, moduleName, tokenizerOptions: opts}};
  }

  // Reference to the currently processing assembler. If the current file
  // errors out so horribly that it hits the outer try block, then we'd
  // lose any error messages from the current assembler (since we aggregate
  // errors at the end.) This is just a cheeky way to grab errors from that
  // assembler if it does explode.
  let currentAssembler: Assembler | undefined;

  try {
    for (let i = 0; i < inputs.length; i++) {
      throwIfCancelled(signal);
      const input = inputs[i];

      if (input.type === 'module') {
        // Already compiled module, just add it
        modules.push(input.module);
        continue;
      }

      if (input.type === 'actions') {
        let module_name = input.name ?? `module_${i}`;
        const {opts, asmOpts} = moduleOpts(module_name);
        const asm = currentAssembler = new Assembler(Cpu.P02, asmOpts);
        const original_module_name = module_name;

        for (const action of input.actions) {
          // Set source info for debug purposes before processing each action
          asm.setSource(toSourceInfo(action.source));

          switch (action.action) {
            case 'code': {
              // For code actions, we need to tokenize and process through the full pipeline
              const toks = new TokenStream(
                callbacks?.readText,
                callbacks?.readBinary,
                opts,
                sourceContents,
                asm.errorCollector
              );
              // Use the first name provided through a code action as the outer module name
              if (module_name === original_module_name && action.name) {
                module_name = action.name;
              }
              const tokenizer = new Tokenizer(action.code, module_name, opts, sourceContents, asm.errorCollector);
              toks.enter(tokenizer);
              const pre = new Preprocessor(toks, asm, undefined, asm.errorCollector,
                                           options?.macroIndex);
              await applyDefines(asm, pre, options?.defines, opts);
              await asm.tokens(pre, signal);
              break;
            }

            case 'label':
              asm.label(action.label);
              break;

            case 'byte':
              asm.byte(...action.bytes);
              break;

            case 'word':
              asm.word(...action.words);
              break;

            case 'hibytes':
              asm.byte(...action.values.map(v => Exprs.hiByte(toValueExpr(v))));
              break;

            case 'lobytes':
              asm.byte(...action.values.map(v => Exprs.loByte(toValueExpr(v))));
              break;

            case 'literal':
              asm.byteInternal(action.values, new MaxKeySizeCacheMap());
              break;

            case 'org':
              asm.org(action.addr, action.name);
              break;

            case 'segment':
              asm.segment(...action.name);
              break;

            case 'reloc':
              asm.reloc(action.name);
              break;

            case 'export':
              asm.export(action.name);
              break;

            case 'exportzp':
              asm.exportzp(...action.names);
              break;

            case 'import':
              asm.import(...action.names);
              break;

            case 'importzp':
              asm.importzp(...action.names);
              break;

            case 'global':
              asm.global(...action.names);
              break;

            case 'globalzp':
              asm.globalzp(...action.names);
              break;

            case 'align':
              asm.align(action.boundary, action.fill);
              break;

            case 'res':
              asm.res(action.count, action.value);
              break;

            case 'charmap':
              asm.charMap(action.code, action.target);
              break;

            case 'strmap':
              asm.strMap(action.key, action.bytes);
              break;

            case 'pushcharmap':
              asm.pushCharmap();
              break;

            case 'popcharmap':
              asm.popCharmap();
              break;

            case 'assign': {
              const value = typeof action.value === 'string'
                ? parseInt(action.value, 10)
                : action.value;
              asm.assign(action.name, value);
              break;
            }

            case 'set': {
              const value = typeof action.value === 'string'
                ? parseInt(action.value, 10)
                : action.value;
              asm.set(action.name, value);
              break;
            }

            case 'free':
              asm.free(action.size);
              break;

            default:
              console.warn(`Unknown action type:`, action);
          }
        }

        const module = asm.module();
        module.name = module_name;
        modules.push(module);
        allMessages.push(...asm.getMessages());
        currentAssembler = undefined;
        continue;
      }

      // Process source code
      const {opts, asmOpts} = moduleOpts(input.name);
      const asm = currentAssembler = new Assembler(Cpu.P02, asmOpts);
      const toks = new TokenStream(
        callbacks?.readText,
        callbacks?.readBinary,
        opts,
        sourceContents,
        asm.errorCollector
      );

      // Tokenize and assemble source code
      const tokenizer = new Tokenizer(input.code, input.name, opts, sourceContents, asm.errorCollector);
      toks.enter(tokenizer);
      const pre = new Preprocessor(toks, asm, undefined, asm.errorCollector,
                                   options?.macroIndex);
      await applyDefines(asm, pre, options?.defines, opts);
      await asm.tokens(pre, signal);

      const module = asm.module();
      module.name = input.name;
      modules.push(module);

      // Collect messages from this assembler
      allMessages.push(...asm.getMessages());
      currentAssembler = undefined;
    }
  } catch (err) {
    // if we have currentAssembler, it means there was some unrecoverable error,
    // so grab whatever messages we can scavenge
    if (currentAssembler) allMessages.push(...currentAssembler.getMessages());
    pushException(allMessages, err);
    return { success: false, modules, messages: allMessages };
  }

  const hasErrors = allMessages.some(m => m.level === 'error');
  return { success: !hasErrors, modules, messages: allMessages };
}

export interface LinkResult {
  /** Whether linking succeeded (no errors) */
  success: boolean;
  /** Binary output or IPS patch (empty if errors) */
  data: Uint8Array;
  /** Any outputs named in a linker config that was the original %o output */
  extraOutputs: {name: string, data: Uint8Array}[];
  /** Debug information in MLB format (empty string if sourceContents not provided or errors) */
  debugInfo: string;
  /** Linker map (empty unless requested or on errors) */
  mapFile: string;
  /** All messages (errors, warnings, info) from compilation */
  messages: AssemblerMessage[];
}

/**
 * Link modules into final binary or IPS patch
 *
 * @param modules - Array of Module objects to link
 * @param options - Linker configuration
 * @param outputFormat - Output format ('binary' or 'ips')
 * @param sourceContents - Optional source contents for debug info generation
 * @param messages - Optional array of messages to include in result
 * @returns Link result with binary data, debug info, and messages
 */
export function link(
  modules: Module[],
  options?: LinkerOptions,
  outputFormat: 'binary' | 'ips' = 'binary',
  sourceContents?: SourceContents,
  messages: AssemblerMessage[] = [],
  signal?: CancelSignal
): LinkResult {
  // Create a copy of messages so we can add to it
  const allMessages = [...messages];
  const collector = new ErrorCollector();

  try {
    const linker = new Linker({
      target: options?.target,
      linkerConfig: options?.linkerConfig,
      linkerConfigName: options?.linkerConfigName,
      defines: options?.defines,
      errorCollector: collector,
    });

    // Load base ROM if provided and not generating IPS
    let data: Uint8Array | null = null;
    if (outputFormat !== 'ips' && options?.baseRom) {
      data = options.baseRom;
      linker.base(data, options.baseRomOffset ?? 0);
    }

    for (const module of modules) {
      linker.read(module);
    }

    const out = linker.link(signal);
    // A config can send segments to files of their own; only the main output
    // is patched into the base ROM.
    const extraOutputs = linker.outputFiles();

    // Generate output based on format
    let binaryData: Uint8Array;
    if (outputFormat === 'ips') {
      if (extraOutputs.length) {
        throw new Error(`Cannot write an IPS patch from a linker config with ${
                        ''}more than one output file (${
                        extraOutputs.map(o => o.name).join(', ')})`);
      }
      binaryData = out.toIpsPatch();
    } else {
      if (!data) data = new Uint8Array(out.length);
      out.apply(data);
      binaryData = data;
    }

    const debugInfo = linker.getDebugInfo(sourceContents, options?.debugLevel ?? 0);
    const mapFile = options?.generateMapFile ? linker.report(true) : '';

    allMessages.push(...collector.getMessages());
    const hasErrors = allMessages.some(m => m.level === 'error');

    return {
      success: !hasErrors,
      data: binaryData,
      extraOutputs,
      debugInfo,
      mapFile,
      messages: allMessages
    };
  } catch (err) {
    // Linker threw an error - add it to messages and return failure.
    allMessages.push(...collector.getMessages());
    pushException(allMessages, err);

    return {
      success: false,
      data: new Uint8Array(0),
      extraOutputs: [],
      debugInfo: '',
      mapFile: '',
      messages: allMessages
    };
  }
}

/**
 * Result of the canonical compile() entrypoint.
 */
export interface CompileResult {
  /** Whether compilation succeeded (no errors) */
  success: boolean;
  /**
   * Named output files. The linked ROM/IPS is a `type: 'binary'` entry; debug info
   * (`type: 'debug'`) and serialized .o modules (`type: 'object'`) ride in the same
   * list rather than as separate fields. Use findOutput()/the type tag to pick one.
   */
  outputs: OutputFile[];
  /** All messages (errors, warnings, info) from compilation */
  messages: AssemblerMessage[];
}

/**
 * Find the first output of a given type (e.g. the linked ROM or the debug sidecar).
 */
export function findOutput(result: CompileResult, type: OutputType): OutputFile | undefined {
  return result.outputs.find(o => o.type === type);
}

/**
 * Create a failure CompileResult from an exception. `collected` carries any diagnostics
 * produced by the assembler that happened before an unrecoverable exception occured
 */
function failureFromException(err: unknown, collected: AssemblerMessage[] = []): CompileResult {
  const messages = [...collected];
  pushException(messages, err);
  return {
    success: false,
    outputs: [],
    messages
  };
}

function pushException(messages: AssemblerMessage[], err: unknown): void {
  if (err instanceof SourceError && err.recorded) return;
  messages.push(messageFromException(err));
}

function messageFromException(err: unknown): AssemblerMessage {
  return {
    level: 'error',
    message: err instanceof Error ? err.message : String(err),
    source: err instanceof SourceError ? err.source : undefined,
    stack: err instanceof Error ? err.stack : undefined
  };
}

/**
 * Serialize a module to the .o JSON format, base64-encoding chunk data.
 * This data will get compressed later for the final output.
 */
function serializeModule(m: Module, keepDebugInfo = true): string {
  const base64 = new Base64();
  return JSON.stringify(m, (k, v) => {
    if (k === 'data' && v instanceof Uint8Array) {
      return base64.encode(v);
    }
    if (!keepDebugInfo && k === 'source') {
      return undefined;
    }
    // Convert maps to [key, value] arrays so we can properly save it to the module
    if (v instanceof Map) {
      return [...v];
    }
    return v;
  });
}

/** Leading bytes of a gzip member (RFC 1952): magic 0x1f 0x8b, method 0x08 (deflate). */
const GZIP_MAGIC = [0x1f, 0x8b, 0x08];

/** Whether `data` starts with a gzip header, i.e. is a compressed `.o` rather than raw JSON. */
export function isGzip(data: Uint8Array): boolean {
  return data.length >= GZIP_MAGIC.length && GZIP_MAGIC.every((b, i) => data[i] === b);
}

/**
 * The source info added to the output json is hilariously bad for disk size, so we
 * compress the object files to save a lotta space. In my testing its around 10x just
 * from gzip + another 2.5x saved just from cutting indents outta the json file.
 * The gzipCodec needs to be setup before calling libassembler, and you can use the included
 * `pako` gzip library if you don't care.
 */
export function serializeObjectFile(m: Module, keepDebugInfo = true): Uint8Array {
  return gzipCodec().gzip(new TextEncoder().encode(serializeModule(m, keepDebugInfo)));
}

/**
 * Decode a `.o` file produced by serializeObjectFile back into a Module.
 */
export function deserializeObjectFile(data: Uint8Array, name = 'object file'): Module {
  let json: string;
  try {
    json = new TextDecoder().decode(gzipCodec().gunzip(data));
  } catch (err) {
    throw new Error(`${name}: could not decompress: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`${name}: not a valid object file (malformed JSON)`);
  }
  const validated = parseModule(parsed);
  if (!validated.ok) throw new Error(`${name}: not a valid object file: ${validated.error}`);
  return validated.value;
}

/**
 * Parses the JSON (expanding base64 byte/word literals) and validates the structure.
 */
export function deserializeRequest(requestJson: string): Js65Request {
  const base64 = new Base64();
  // The transport encodes byte/word literals as base64 to keep the JSON compact; expand
  // them back to number arrays as the request is parsed.
  const parsed: unknown = JSON.parse(requestJson, (key, value) =>
    (key === 'bytes' || key === 'words') && typeof value === 'string' ? base64.decode(value) : value);
  const validated = parseRequest(parsed);
  if (!validated.ok) throw new Error(`Invalid compile request: ${validated.error}`);
  return validated.value;
}

/**
 * The main entrypoint which does all the compile steps (assembly + link)
 * Builds everything end to end into one amalgamated output.
 *
 * @param inputs - sources / modules / action lists to assemble and link
 * @param options - compile options for assembler and linker, similar to the CLI options
 * @param callbacks - .include / .incbin readers (required only if a directive needs one)
 * @param baseRom - Optional base ROM the linker patches into
 */
export async function compile(
  inputs: AssemblyInput[],
  options: Js65Options = {},
  callbacks?: FileCallbacks,
  baseRom?: Uint8Array,
  signal?: CancelSignal,
): Promise<CompileResult> {
  const base64 = new Base64();
  // Diagnostics produced so far, so a throw later in the pipeline (serializing, linking)
  // still reports the warnings/errors assembly already found.
  let collected: AssemblerMessage[] = [];
  try {
    throwIfCancelled(signal);
    const asmOpts: AssemblerOptions = {
      includePaths: options.includePaths,
      binIncludePaths: options.binIncludePaths,
      generateDebugInfo: options.generateDebugInfo,
      defines: options.defines,
      features: options.features,
      allowBrackets: options.allowBrackets,
      labelsWithoutColons: options.labelsWithoutColons,
      pcAssignment: options.pcAssignment,
      forceRange: options.forceRange,
      cComments: options.cComments,
      lineContinuations: options.lineContinuations,
      numberSeparators: options.numberSeparators,
      leadingDotInIdentifiers: options.leadingDotInIdentifiers,
      lint: options.lint,
    };
    const linkerOpts: LinkerOptions = {
      target: options.target,
      baseRom,
      baseRomOffset: options.baseRomOffset,
      defines: options.defines,
      debugLevel: options.debugLevel,
      generateMapFile: options.generateMapFile,
      linkerConfig: options.linkerConfig,
      linkerConfigName: options.linkerConfigName,
    };
    const outputFormat: OutputFormat = options.outputFormat ?? 'binary';
    const sourceContents = options.generateDebugInfo ? new SourceContents() : undefined;

    // .include / .incbin readers. They are optional (sources may use neither); a missing
    // one only fails if a directive actually needs it. readBinary may hand back base64
    // (some hosts can only marshal binary as a string), so decode it to bytes here.
    const fileCallbacks: FileCallbacks = {
      readText: async (basePath, relPath) => {
        if (!callbacks?.readText) throw new Error(`No readText callback provided (reading ${basePath}/${relPath})`);
        return await callbacks.readText(basePath, relPath);
      },
      readBinary: async (basePath, relPath) => {
        if (!callbacks?.readBinary) throw new Error(`No readBinary callback provided (reading ${basePath}/${relPath})`);
        const data = await callbacks.readBinary(basePath, relPath);
        return typeof data === 'string' ? base64.decode(data) : data;
      },
    };

    const asm = await assemble(inputs, asmOpts, fileCallbacks, sourceContents, signal);
    collected = [...asm.messages];
    if (!asm.success) {
      return { success: false, outputs: [], messages: asm.messages };
    }

    if (outputFormat === 'object') {
      const outputs: OutputFile[] = asm.modules.map(m => ({
        name: `${m.name || 'module'}.o`,
        data: serializeObjectFile(m, !!options.generateDebugInfo),
        type: 'object',
      }));
      return { success: true, outputs, messages: asm.messages };
    }

    const lr = link(asm.modules, linkerOpts, outputFormat, sourceContents, asm.messages, signal);
    const outputName = outputFormat === 'ips' ? 'out.ips' : 'out.nes';
    // The main output comes first, so anything picking "the binary" out of the
    // list still gets the ROM rather than one of the config's extra files.
    const outputs: OutputFile[] = [{ name: outputName, data: lr.data, type: 'binary' }];
    for (const extra of lr.extraOutputs) {
      outputs.push({ name: extra.name, data: extra.data, type: 'binary' });
    }
    // Debug info rides as a sidecar output (type 'debug') rather than a separate field.
    if (lr.debugInfo) {
      outputs.push({ name: 'out.mlb', data: new TextEncoder().encode(lr.debugInfo), type: 'debug' });
    }
    if (lr.mapFile) {
      outputs.push({ name: 'out.map', data: new TextEncoder().encode(lr.mapFile), type: 'map' });
    }
    return {
      success: lr.success,
      outputs,
      messages: lr.messages,
    };
  } catch (err) {
    return failureFromException(err, collected);
  }
}

/**
 * Like `compile` but accepts all the compile data passed as a string, so you can use JSON
 * serialization to pass it in without needing to deal with creating real JS Objects.
 */
export async function compileRequest(
  requestJson: string,
  callbacks?: FileCallbacks,
  baseRom?: Uint8Array,
  signal?: CancelSignal,
): Promise<CompileResult> {
  try {
    const { inputs, options } = deserializeRequest(requestJson);
    return await compile(inputs, options, callbacks, baseRom, signal);
  } catch (err) {
    return failureFromException(err);
  }
}

/**
 * Adapter for the .NET WASM browser engine (JSImport). We have to work around limitations
 * in JS interop and we do that by stringify-ing pretty much all the things.
 */
export async function compileBrowser(
  requestJson: string,
  readText: (basePath: string, relPath: string) => string | Promise<string>,
  readBinaryBase64: (basePath: string, relPath: string) => string | Promise<string>,
  baseRom: ArrayLike<number> | undefined,
  shouldCancel?: () => boolean,
): Promise<string> {
  const base64 = new Base64();
  const callbacks: FileCallbacks = {
    readText: async (basePath, relPath) => readText(basePath, relPath),
    readBinary: async (basePath, relPath) => base64.decode(await readBinaryBase64(basePath, relPath)),
  };
  // The marshaller hands the byte[] param across as a JS number array; normalize to a
  // real Uint8Array for the linker.
  const rom = baseRom && baseRom.length > 0
    ? (baseRom instanceof Uint8Array ? baseRom : new Uint8Array(Array.from(baseRom)))
    : undefined;

  // JSImport can't marshal an AbortSignal, so the host passes a polling predicate; adapt it to
  // work with CancelSignal. 
  // This doesn't work well in WASM, the .NET token only flips while host code
  // runs, i.e. cancellation is observed at the file-callback await boundaries, not mid-compute.
  // Someday we'll get the async worker thread approach and it should work better for this.
  const signal: CancelSignal | undefined = shouldCancel ? { get aborted() { return shouldCancel(); } } : undefined;

  const result = await compileRequest(requestJson, callbacks, rom, signal);
  const resultJson = JSON.stringify({
    success: result.success,
    outputs: result.outputs.map(o => ({ name: o.name, data: base64.encode(o.data), type: o.type })),
    messages: result.messages,
  });
  return base64.encode(new TextEncoder().encode(resultJson));
}
