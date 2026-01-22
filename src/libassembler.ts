
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { Assembler } from './assembler.ts';
import { Cpu } from './cpu.ts';
import { Linker } from './linker.ts';
import { Preprocessor } from './preprocessor.ts';
import { Tokenizer } from './tokenizer.ts';
import { TokenStream, SourceContents } from './tokenstream.ts';
import { type Module, ModuleZ, type Segment } from "./module.ts";
import type { Expr } from './expr.ts';
import type { SourceInfo } from './token.ts';

// Re-export Assembler for direct programmatic use
export { Assembler, Cpu, SourceContents };
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
 * Assemble source files into Module objects
 *
 * @param inputs - Array of source code or modules to assemble
 * @param options - Assembler configuration
 * @param callbacks - File system callbacks for .include/.incbin
 * @param sourceContents - Optional SourceContents to store source for debug info
 * @returns Array of compiled Module objects
 */
export async function assemble(
  inputs: AssemblyInput[],
  options?: AssemblerOptions,
  callbacks?: FileCallbacks,
  sourceContents?: SourceContents
): Promise<Module[]> {
  const modules: Module[] = [];

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
      const parsedModule = await ModuleZ.safeParseAsync(obj);
      if (parsedModule.success) {
        // Successfully parsed as a module
        modules.push(parsedModule.data);
        continue;
      }
    } catch (_err) {
      // Not JSON or not a valid module, treat as source code
    }

    // Tokenize and assemble source code
    const tokenizer = new Tokenizer(input.code, input.name, opts, sourceContents);
    toks.enter(tokenizer);
    const pre = new Preprocessor(toks, asm);
    await asm.tokens(pre);

    const module = asm.module();
    module.name = input.name;
    modules.push(module);
  }

  return modules;
}

/**
 * Result of linking operation
 */
export interface LinkResult {
  /** Binary output or IPS patch */
  data: Uint8Array;
  /** Debug information in MLB format (empty string if sourceContents not provided) */
  debugInfo: string;
}

/**
 * Link modules into final binary or IPS patch
 *
 * @param modules - Array of Module objects to link
 * @param options - Linker configuration
 * @param outputFormat - Output format ('binary' or 'ips')
 * @param sourceContents - Optional source contents for debug info generation
 * @returns Link result with binary data and debug info
 */
export function link(
  modules: Module[],
  options?: LinkerOptions,
  outputFormat: OutputFormat = 'binary',
  sourceContents?: SourceContents
): LinkResult {
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

  return {
    data: binaryData,
    debugInfo
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
 * @returns Link result with binary data and debug info
 */
export async function compile(
  inputs: AssemblyInput[],
  assemblerOpts?: AssemblerOptions,
  linkerOpts?: LinkerOptions,
  outputFormat: OutputFormat = 'binary',
  callbacks?: FileCallbacks,
  sourceContents?: SourceContents
): Promise<LinkResult> {
  const modules = await assemble(inputs, assemblerOpts, callbacks, sourceContents);
  return link(modules, linkerOpts, outputFormat, sourceContents);
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
 * @returns Array of compiled Module objects
 */
export async function assembleActions(
  actionModules: AssemblyAction[][],
  options?: AssemblerOptions,
  callbacks?: FileCallbacks,
  sourceContents?: SourceContents
): Promise<Module[]> {
  const modules: Module[] = [];

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
          const tokenizer = new Tokenizer(action.code, action.name || `module_${moduleIdx}`, opts, sourceContents);
          toks.enter(tokenizer);
          const pre = new Preprocessor(toks, asm);
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
    module.name = `module_${moduleIdx}`;
    modules.push(module);
  }

  return modules;
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
 * @returns Link result with binary data and debug info
 */
export async function compileActions(
  actionModules: AssemblyAction[][],
  assemblerOpts?: AssemblerOptions,
  linkerOpts?: LinkerOptions,
  outputFormat: OutputFormat = 'binary',
  callbacks?: FileCallbacks,
  sourceContents?: SourceContents
): Promise<LinkResult> {
  const modules = await assembleActions(actionModules, assemblerOpts, callbacks, sourceContents);
  return link(modules, linkerOpts, outputFormat, sourceContents);
}
