
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
import { type Module, ModuleZ } from "./module.ts";

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
  debugLevel?: number; // -1 = disabled, 0 = comments/labels only, 1 = full source
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

  // Feed all modules to the linker
  for (const module of modules) {
    linker.read(module);
  }

  // Run linking
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

  // Generate debug info if source contents provided
  const debugInfo = linker.getDebugInfo(sourceContents, options?.debugLevel ?? 0);

  return {
    data: binaryData,
    debugInfo
  };
}

/**
 * Convenience function: assemble + link in one step
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
