
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
import { parseModule, parseActionModules } from "./validate_modules.ts";
import type { Expr } from './expr.ts';
import type { SourceInfo, AssemblerMessage } from './token.ts';

// Re-export Assembler for direct programmatic use
export { Assembler, Cpu, SourceContents, Base64 };
export type { Expr, Module, Segment };

/**
 * Assembly input - supports source code or pre-compiled modules
 */
export type AssemblyInput =
  | { type: 'source', code: string, name: string }
  | { type: 'module', module: Module };

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
export type OutputFormat = 'binary' | 'ips';

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

/**
 * Assemble source files into Module objects
 *
 * @param inputs - Array of source code or modules to assemble
 * @param options - Assembler configuration
 * @param callbacks - File system callbacks for .include/.incbin
 * @param sourceContents - Optional SourceContents to store source for debug info
 * @returns Array of compiled Module objects and any messages
 */
export async function assemble(
  inputs: AssemblyInput[],
  options?: AssemblerOptions,
  callbacks?: FileCallbacks,
  sourceContents?: SourceContents
): Promise<AssembleResult> {
  const modules: Module[] = [];
  const allMessages: AssemblerMessage[] = [];

  for (const input of inputs) {
    if (input.type === 'module') {
      // Already compiled module, just add it
      modules.push(input.module);
      continue;
    }

    // Process source code
    const asmOpts = {
      generateDebugInfo: options?.generateDebugInfo
    };
    const asm = new Assembler(Cpu.P02, asmOpts);
    const opts = {
      includePaths: options?.includePaths || [],
      lineContinuations: options?.lineContinuations ?? true,
      numberSeparators: options?.numberSeparators,
      generateDebugInfo: options?.generateDebugInfo
    };

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
    await asm.tokens(pre);

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
 * Result of compilation/linking operation
 */
export interface CompileResult {
  /** Whether compilation succeeded (no errors) */
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
 * @returns Compile result with binary data, debug info, and messages
 */
export function link(
  modules: Module[],
  options?: LinkerOptions,
  outputFormat: OutputFormat = 'binary',
  sourceContents?: SourceContents,
  messages: AssemblerMessage[] = []
): CompileResult {
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

    const out = linker.link();

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

function linkAssembleResult(
  result: AssembleResult,
  linkerOpts?: LinkerOptions,
  outputFormat: OutputFormat = 'binary',
  sourceContents?: SourceContents
): CompileResult {
  if (!result.success) {
    return {
      success: false,
      data: new Uint8Array(0),
      debugInfo: '',
      messages: result.messages
    };
  }
  return link(result.modules, linkerOpts, outputFormat, sourceContents, result.messages);
}

/**
 * Create a failure CompileResult from an exception
 */
function failureFromException(err: unknown): CompileResult {
  return {
    success: false,
    data: new Uint8Array(0),
    debugInfo: '',
    messages: [{
      level: 'error',
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined
    }]
  };
}

/**
 * Assemble + link
 *
 * @param inputs - Array of source code or modules
 * @param assemblerOpts - Assembler configuration
 * @param linkerOpts - Linker configuration
 * @param outputFormat - Output format ('binary' or 'ips')
 * @param callbacks - File system callbacks
 * @param sourceContents - Optional source contents for debug info generation
 * @returns Compile result with binary data, debug info, and messages
 */
export async function compile(
  inputs: AssemblyInput[],
  assemblerOpts?: AssemblerOptions,
  linkerOpts?: LinkerOptions,
  outputFormat: OutputFormat = 'binary',
  callbacks?: FileCallbacks,
  sourceContents?: SourceContents
): Promise<CompileResult> {
  try {
    const result = await assemble(inputs, assemblerOpts, callbacks, sourceContents);
    return linkAssembleResult(result, linkerOpts, outputFormat, sourceContents);
  } catch (err) {
    return failureFromException(err);
  }
}

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
 * Assembles modules from actions, without converting to source text.
 * AssemblyActions are a way to programatically create a module, which is handy
 * for applications that want to write data to the rom without needing to generate
 * source text and passing it in as code.
 *
 * @param actionModules - Array of action arrays (one per module)
 * @param options - Assembler configuration
 * @param callbacks - File system callbacks for .include/.incbin in code actions
 * @param sourceContents - Optional SourceContents for debug info
 * @returns Modules and any messages from assembly
 */
export async function assembleActions(
  actionModules: AssemblyAction[][],
  options?: AssemblerOptions,
  callbacks?: FileCallbacks,
  sourceContents?: SourceContents
): Promise<AssembleResult> {
  const modules: Module[] = [];
  const allMessages: AssemblerMessage[] = [];

  // Helper to convert ActionSource to SourceInfo
  const toSourceInfo = (source?: ActionSource): SourceInfo | undefined => {
    if (!source) return undefined;
    return {
      file: source.file,
      line: source.line,
      column: 0
    };
  };

  for (let moduleIdx = 0; moduleIdx < actionModules.length; moduleIdx++) {
    const actions = actionModules[moduleIdx];
    const asmOpts = {
      generateDebugInfo: options?.generateDebugInfo
    };
    const asm = new Assembler(Cpu.P02, asmOpts);
    let module_name = `module_${moduleIdx}`;
    const original_module_name = module_name;

    for (const action of actions) {
      // Set source info for debug purposes before processing each action
      asm.setSource(toSourceInfo(action.source));

      switch (action.action) {
        case 'code': {
          // For code actions, we need to tokenize and process through the full pipeline
          const opts = {
            includePaths: options?.includePaths || [],
            lineContinuations: options?.lineContinuations ?? true,
            numberSeparators: options?.numberSeparators,
            generateDebugInfo: options?.generateDebugInfo
          };
          const toks = new TokenStream(
            callbacks?.readText,
            callbacks?.readBinary,
            opts,
            sourceContents
          );
          // Use the first name provided through a code action as the outer module name
          if (module_name == original_module_name && action.name) {
            module_name = action.name;
          }
          const tokenizer = new Tokenizer(action.code, module_name, opts, sourceContents, asm.errorCollector);
          toks.enter(tokenizer);
          const pre = new Preprocessor(toks, asm, undefined, asm.errorCollector);
          await asm.tokens(pre);
          break;
        }

        case 'label':
          asm.label(action.label);
          break;

        case 'byte': {
          asm.byte(...action.bytes);
          break;
        }

        case 'word': {
          asm.word(...action.words);
          break;
        }

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

    // Collect messages from this assembler
    allMessages.push(...asm.getMessages());
  }

  const hasErrors = allMessages.some(m => m.level === 'error');
  return { success: !hasErrors, modules, messages: allMessages };
}

/**
 * Convenience function: assemble actions + link in one step
 *
 * @param actionModules - Array of action arrays (one per module)
 * @param assemblerOpts - Assembler configuration
 * @param linkerOpts - Linker configuration
 * @param outputFormat - Output format ('binary' or 'ips')
 * @param callbacks - File system callbacks
 * @param sourceContents - Optional source contents for debug info generation
 * @returns Compile result with binary data, debug info, and messages
 */
export async function compileActions(
  actionModules: AssemblyAction[][],
  assemblerOpts?: AssemblerOptions,
  linkerOpts?: LinkerOptions,
  outputFormat: OutputFormat = 'binary',
  callbacks?: FileCallbacks,
  sourceContents?: SourceContents
): Promise<CompileResult> {
  try {
    const result = await assembleActions(actionModules, assemblerOpts, callbacks, sourceContents);
    return linkAssembleResult(result, linkerOpts, outputFormat, sourceContents);
  } catch (err) {
    return failureFromException(err);
  }
}

/**
 * Browser-compatible wrapper for compileActions that accepts JSON strings and returns base64-encoded result.
 * This function is designed to be called from C# using JSImport in the browser engine.
 *
 * @param modulesJson - JSON string containing array of action modules
 * @param assemblerOptsJson - JSON string containing assembler options
 * @param linkerOptsJson - JSON string containing linker options (baseRom should be base64-encoded)
 * @param outputFormat - Output format ('binary' or 'ips')
 * @param readTextCallback - Callback function for reading text files (basePath, filePath) => content
 * @param readBinaryCallback - Callback function for reading binary files (basePath, filePath) => base64-encoded content
 * @param useSourceContents - Whether to create SourceContents for debug info
 * @returns Promise<string> - Base64-encoded JSON result with romdata and debugfile
 */
export async function compileActionsBrowser(
  modulesJson: string,
  assemblerOptsJson: string,
  linkerOptsJson: string,
  outputFormat: OutputFormat = 'binary',
  readTextCallback: (basePath: string, filePath: string) => string,
  readBinaryCallback: (basePath: string, filePath: string) => string,
  useSourceContents: boolean = false
): Promise<string> {
  const base64 = new Base64();

  try {
    // Parse action modules JSON
    const rawActionModules: unknown = JSON.parse(modulesJson, (key, value) => {
      // Deserialize base64-encoded byte/word arrays into number arrays
      if ((key === 'bytes' || key === 'words') && typeof value === 'string') {
        return base64.decode(value);
      }
      return value;
    });
    // Validate the untrusted action JSON before assembling it.
    const validated = parseActionModules(rawActionModules);
    if (!validated.ok) {
      throw new Error(`Invalid action module input: ${validated.error}`);
    }
    const actionModules: AssemblyAction[][] = validated.value;

    // Parse assembler options
    const assemblerOpts: AssemblerOptions = JSON.parse(assemblerOptsJson);

    // Parse linker options and decode base64 ROM
    const linkerOptsRaw = JSON.parse(linkerOptsJson);
    const linkerOpts: LinkerOptions = {
      ...linkerOptsRaw,
      baseRom: linkerOptsRaw.baseRom ? base64.decode(linkerOptsRaw.baseRom) : undefined
    };

    // Create callbacks object
    const callbacks: FileCallbacks = {
      readText: async (basePath: string, filePath: string) => {
        return readTextCallback(basePath, filePath);
      },
      readBinary: async (basePath: string, filePath: string) => {
        const base64Content = readBinaryCallback(basePath, filePath);
        return base64.decode(base64Content);
      }
    };

    // Create source contents if needed
    const sourceContents = useSourceContents ? new SourceContents() : undefined;

    // Call compileActions
    const result = await compileActions(
      actionModules,
      assemblerOpts,
      linkerOpts,
      outputFormat,
      callbacks,
      sourceContents
    );

    // Encode result as base64 JSON
    const resultJson = JSON.stringify({
      success: result.success,
      romdata: base64.encode(result.data),
      debugfile: result.debugInfo || '',
      messages: result.messages
    });

    return base64.encode(new TextEncoder().encode(resultJson));
  } catch (err) {
    // Return a failure result encoded in the same format
    const failureResult = failureFromException(err);
    const resultJson = JSON.stringify({
      success: failureResult.success,
      romdata: base64.encode(failureResult.data),
      debugfile: failureResult.debugInfo,
      messages: failureResult.messages
    });
    return base64.encode(new TextEncoder().encode(resultJson));
  }
}
