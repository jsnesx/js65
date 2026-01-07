
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
import { TokenStream } from './tokenstream.ts';
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
  skipSourceAnnotations?: boolean;
}

/**
 * Options for linking phase
 */
export interface LinkerOptions {
  target?: string;
  baseRom?: Uint8Array;
  baseRomOffset?: number;
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
 * Extracted from cli.ts assemble() method
 *
 * @param inputs - Array of source code or modules to assemble
 * @param options - Assembler configuration
 * @param callbacks - File system callbacks for .include/.incbin
 * @returns Array of compiled Module objects
 */
export async function assemble(
  inputs: AssemblyInput[],
  options?: AssemblerOptions,
  callbacks?: FileCallbacks
): Promise<Module[]> {
  const modules: Module[] = [];

  for (const input of inputs) {
    if (input.type === 'module') {
      // Already compiled module, just add it
      modules.push(input.module);
      continue;
    }

    // Process source code
    const asm = new Assembler(Cpu.P02);
    const opts = {
      includePaths: options?.includePaths || [],
      lineContinuations: options?.lineContinuations ?? true,
      numberSeparators: options?.numberSeparators,
      skipSourceAnnotations: options?.skipSourceAnnotations
    };

    const toks = new TokenStream(
      callbacks?.readText,
      callbacks?.readBinary,
      opts
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
    const tokenizer = new Tokenizer(input.code, input.name, opts);
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
 * Link modules into final binary or IPS patch
 * Extracted from cli.ts link() method
 *
 * @param modules - Array of Module objects to link
 * @param options - Linker configuration
 * @param outputFormat - Output format ('binary' or 'ips')
 * @returns Binary output or IPS patch
 */
export function link(
  modules: Module[],
  options?: LinkerOptions,
  outputFormat: OutputFormat = 'binary'
): Uint8Array {
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
  if (outputFormat === 'ips') {
    return out.toIpsPatch();
  } else {
    if (!data) data = new Uint8Array(out.length);
    out.apply(data);
    return data;
  }
}

/**
 * Convenience function: assemble + link in one step
 *
 * @param inputs - Array of source code or modules
 * @param assemblerOpts - Assembler configuration
 * @param linkerOpts - Linker configuration
 * @param outputFormat - Output format ('binary' or 'ips')
 * @param callbacks - File system callbacks
 * @returns Binary output according to output options
 */
export async function compile(
  inputs: AssemblyInput[],
  assemblerOpts?: AssemblerOptions,
  linkerOpts?: LinkerOptions,
  outputFormat: OutputFormat = 'binary',
  callbacks?: FileCallbacks
): Promise<Uint8Array> {
  const modules = await assemble(inputs, assemblerOpts, callbacks);
  return link(modules, linkerOpts, outputFormat);
}
