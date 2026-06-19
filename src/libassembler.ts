
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Assembler } from './assembler.ts';
import { Base64 } from './base64.ts';
import { Cpu } from './cpu.ts';
import { Linker } from './linker.ts';
import { Preprocessor } from './preprocessor.ts';
import { Tokenizer } from './tokenizer.ts';
import { TokenStream, SourceContents } from './tokenstream.ts';
import { type Module, type Segment } from "./module.ts";
import { parseModule, parseRequest } from "./validate_modules.ts";
import type { Expr } from './expr.ts';
import type { SourceInfo, AssemblerMessage } from './token.ts';

// Re-export Assembler for direct programmatic use
export { Assembler, Cpu, SourceContents, Base64 };
export type { Expr, Module, Segment };

/**
 * Source location for an action (from the caller's code)
 */
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
  | { action: 'byte', bytes: Array<number | { op: 'sym', sym: string }>, source?: ActionSource }
  | { action: 'word', words: Array<number | { op: 'sym', sym: string }>, source?: ActionSource }
  | { action: 'org', addr: number, name?: string, source?: ActionSource }
  | { action: 'segment', name: string | string[], source?: ActionSource }
  | { action: 'reloc', name?: string, source?: ActionSource }
  | { action: 'export', name: string, source?: ActionSource }
  | { action: 'assign', name: string, value: number | string, source?: ActionSource }
  | { action: 'set', name: string, value: number | string, source?: ActionSource }
  | { action: 'free', size: number, source?: ActionSource };

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
 * Options for assembly phase
 */
export interface AssemblerOptions {
  includePaths?: string[];
  lineContinuations?: boolean;
  numberSeparators?: boolean;
  generateDebugInfo?: boolean;
}

/**
 * Options for linking phase
 */
export interface LinkerOptions {
  target?: string;
  baseRom?: Uint8Array;
  baseRomOffset?: number;
  /** Debug level for debug info generation:
   * -1 = disabled
   *  0 = comments/labels only
   *  1 = full source
   *  2 = full source + file:line location suffix
   */
  debugLevel?: number;
}

/**
 * Output format control
 */
export type OutputFormat = 'binary' | 'ips' | 'object';

/**
 * The flat options bag every frontend speaks. The textual fields cross the JSON
 * boundary as part of a Js65Request.
 */
export interface Js65Options {
  includePaths?: string[];
  lineContinuations?: boolean;
  numberSeparators?: boolean;
  generateDebugInfo?: boolean;
  debugLevel?: number;
  target?: string;
  baseRomOffset?: number;
  outputFormat?: OutputFormat;
}

/**
 * Contains the post-validated data used for compilation.
 */
export interface Js65Request {
  inputs: AssemblyInput[];
  options: Js65Options;
}

/**
 * The kind of artifact an OutputFile holds. Kept open-ended (a plain string union)
 * so new kinds - e.g. 'listing' - can be added without churning every transport:
 *   - 'binary' : a linked ROM image or IPS patch
 *   - 'object' : a serialized .o module
 *   - 'debug'  : debug info (currently MLB labels)
 *   - 'source' : generated source text
 */
export type OutputType = 'source' | 'binary' | 'object' | 'debug';

/**
 * One named output produced by a compile. `type` distinguishes the binary ROM/IPS
 * from sidecar artifacts (debug info, .o modules) that travel in the same list.
 */
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

/**
 * Result type for assemble that includes collected messages
 */
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

/**
 * Assemble source files, pre-compiled modules, and/or action lists into
 * Module objects.
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

  const opts = {
    includePaths: options?.includePaths || [],
    lineContinuations: options?.lineContinuations ?? true,
    numberSeparators: options?.numberSeparators,
    generateDebugInfo: options?.generateDebugInfo
  };
  const asmOpts = {
    generateDebugInfo: options?.generateDebugInfo
  };

  for (let i = 0; i < inputs.length; i++) {
    throwIfCancelled(signal);
    const input = inputs[i];

    if (input.type === 'module') {
      // Already compiled module, just add it
      modules.push(input.module);
      continue;
    }

    if (input.type === 'actions') {
      const asm = new Assembler(Cpu.P02, asmOpts);
      let module_name = input.name ?? `module_${i}`;
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
              sourceContents
            );
            // Use the first name provided through a code action as the outer module name
            if (module_name === original_module_name && action.name) {
              module_name = action.name;
            }
            const tokenizer = new Tokenizer(action.code, module_name, opts, sourceContents, asm.errorCollector);
            toks.enter(tokenizer);
            const pre = new Preprocessor(toks, asm, undefined, asm.errorCollector);
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
      continue;
    }

    // Process source code
    const asm = new Assembler(Cpu.P02, asmOpts);
    const toks = new TokenStream(
      callbacks?.readText,
      callbacks?.readBinary,
      opts,
      sourceContents
    );

    // Try to parse as JSON Module first (for .o files)
    try {
      const obj = JSON.parse(input.code);
      const parsedModule = parseModule(obj);
      if (parsedModule.ok) {
        // Successfully parsed as a module
        modules.push(parsedModule.value);
        continue;
      }
    } catch (_err) {
      // Not JSON or not a valid module, treat as source code
    }

    // Tokenize and assemble source code
    const tokenizer = new Tokenizer(input.code, input.name, opts, sourceContents, asm.errorCollector);
    toks.enter(tokenizer);
    const pre = new Preprocessor(toks, asm, undefined, asm.errorCollector);
    await asm.tokens(pre, signal);

    const module = asm.module();
    module.name = input.name;
    modules.push(module);

    // Collect messages from this assembler
    allMessages.push(...asm.getMessages());
  }

  const hasErrors = allMessages.some(m => m.level === 'error');
  return { success: !hasErrors, modules, messages: allMessages };
}

/**
 * Result of a link() call - the low-level binary/IPS output for one set of
 * already-assembled modules.
 */
export interface LinkResult {
  /** Whether linking succeeded (no errors) */
  success: boolean;
  /** Binary output or IPS patch (empty if errors) */
  data: Uint8Array;
  /** Debug information in MLB format (empty string if sourceContents not provided or errors) */
  debugInfo: string;
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

  try {
    const linker = new Linker({ target: options?.target });

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

    // Generate output based on format
    let binaryData: Uint8Array;
    if (outputFormat === 'ips') {
      binaryData = out.toIpsPatch();
    } else {
      if (!data) data = new Uint8Array(out.length);
      out.apply(data);
      binaryData = data;
    }

    const debugInfo = linker.getDebugInfo(sourceContents, options?.debugLevel ?? 0);

    const hasErrors = allMessages.some(m => m.level === 'error');

    return {
      success: !hasErrors,
      data: binaryData,
      debugInfo,
      messages: allMessages
    };
  } catch (err) {
    // Linker threw an error - add it to messages and return failure
    allMessages.push({
      level: 'error',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    });

    return {
      success: false,
      data: new Uint8Array(0),
      debugInfo: '',
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
 * Create a failure CompileResult from an exception
 */
function failureFromException(err: unknown): CompileResult {
  return {
    success: false,
    outputs: [],
    messages: [{
      level: 'error',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    }]
  };
}

/**
 * Serialize a module to the .o JSON format, base64-encoding chunk data.
 */
function serializeModule(m: Module): string {
  const base64 = new Base64();
  return JSON.stringify(m, (k, v) => {
    if (k === 'data' && v instanceof Uint8Array) {
      return base64.encode(v);
    }
    return v;
  }, '  ');
}

/**
 * Deserialize a Js65Request JSON ({ inputs, options }) into typed inputs.
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
 * Canonical compile entrypoint: assembles and (unless outputFormat is 'object') links
 * the given typed inputs, returning the structured result. Never throws: failures come
 * back as a failure CompileResult. String-transport callers deserialize their JSON with
 * deserializeRequest() first, then call this with the typed inputs/options.
 *
 * @param inputs - sources / modules / action lists to assemble and link
 * @param options - flat options bag (text fields only; baseRom is the separate arg)
 * @param callbacks - .include / .incbin readers (required only if a directive needs one)
 * @param baseRom - Optional base ROM the linker patches into (raw bytes, not base64)
 */
export async function compile(
  inputs: AssemblyInput[],
  options: Js65Options = {},
  callbacks?: FileCallbacks,
  baseRom?: Uint8Array,
  signal?: CancelSignal,
): Promise<CompileResult> {
  const base64 = new Base64();
  try {
    throwIfCancelled(signal);
    const asmOpts: AssemblerOptions = {
      includePaths: options.includePaths,
      lineContinuations: options.lineContinuations,
      numberSeparators: options.numberSeparators,
      generateDebugInfo: options.generateDebugInfo,
    };
    const linkerOpts: LinkerOptions = {
      target: options.target,
      baseRom,
      baseRomOffset: options.baseRomOffset,
      debugLevel: options.debugLevel,
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
    if (!asm.success) {
      return { success: false, outputs: [], messages: asm.messages };
    }

    if (outputFormat === 'object') {
      const outputs: OutputFile[] = asm.modules.map(m => ({
        name: `${m.name || 'module'}.o`,
        data: new TextEncoder().encode(serializeModule(m)),
        type: 'object',
      }));
      return { success: true, outputs, messages: asm.messages };
    }

    const lr = link(asm.modules, linkerOpts, outputFormat, sourceContents, asm.messages, signal);
    const outputName = outputFormat === 'ips' ? 'out.ips' : 'out.nes';
    const outputs: OutputFile[] = [{ name: outputName, data: lr.data, type: 'binary' }];
    // Debug info rides as a sidecar output (type 'debug') rather than a separate field.
    if (lr.debugInfo) {
      outputs.push({ name: 'out.mlb', data: new TextEncoder().encode(lr.debugInfo), type: 'debug' });
    }
    return {
      success: lr.success,
      outputs,
      messages: lr.messages,
    };
  } catch (err) {
    return failureFromException(err);
  }
}

/**
 * String-transport entry for the frontends so they don't need to validate everything. Deserializes
 * a Js65RequestData into the components and then compiles it, if the input fails validation, this
 * catches the error and returns a `CompileResult` with the error message
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
  // the CancelSignal shape. 
  // This doesn't work well in WASM, the .NET token only flips while host code
  // runs, i.e. cancellation is observed at the file-callback await boundaries, not mid-compute.
  const signal: CancelSignal | undefined = shouldCancel ? { get aborted() { return shouldCancel(); } } : undefined;

  const result = await compileRequest(requestJson, callbacks, rom, signal);
  const resultJson = JSON.stringify({
    success: result.success,
    outputs: result.outputs.map(o => ({ name: o.name, data: base64.encode(o.data), type: o.type })),
    messages: result.messages,
  });
  return base64.encode(new TextEncoder().encode(resultJson));
}
