
// SPDX-License-Identifier: MPL-2.0

// Fluent builder API for constructing modules programmatically instead of writing source
// text or hand-assembling an actions[] array.

import { compile, type AssemblyAction, type AssemblyInput, type CancelSignal,
         type CompileResult, type FileCallbacks, type Js65Options } from './libassembler.ts';

type ByteWordValue = number | { op: 'sym', sym: string };
type ByteValue = ByteWordValue | string;

/** A symbolic reference usable anywhere a byte/word literal is expected. */
export function sym(name: string): { op: 'sym', sym: string } {
  return { op: 'sym', sym: name };
}

/**
 * Fluent builder for "actions" that you can take. For code blocks use `code`, everything
 * else is intended for programmatic access where you need to conditionally set values
 * from your main application. 
 */
export class AsmModule {
  readonly actions: AssemblyAction[] = [];

  constructor(public name?: string) {}

  code(code: string, name?: string): this {
    this.actions.push({ action: 'code', code, name });
    return this;
  }

  label(label: string): this {
    this.actions.push({ action: 'label', label });
    return this;
  }

  byte(bytes: ByteValue | ByteValue[]): this {
    this.actions.push({ action: 'byte', bytes: Array.isArray(bytes) ? bytes : [bytes] });
    return this;
  }

  word(words: ByteWordValue | ByteWordValue[]): this {
    this.actions.push({ action: 'word', words: Array.isArray(words) ? words : [words] });
    return this;
  }

  hibytes(values: ByteWordValue | ByteWordValue[]): this {
    this.actions.push({ action: 'hibytes', values: Array.isArray(values) ? values : [values] });
    return this;
  }

  lobytes(values: ByteWordValue | ByteWordValue[]): this {
    this.actions.push({ action: 'lobytes', values: Array.isArray(values) ? values : [values] });
    return this;
  }

  literal(values: ByteValue | ByteValue[]): this {
    this.actions.push({ action: 'literal', values: Array.isArray(values) ? values : [values] });
    return this;
  }

  org(addr: number, name?: string): this {
    this.actions.push({ action: 'org', addr, name });
    return this;
  }

  segment(name: string | string[]): this {
    this.actions.push({ action: 'segment', name: Array.isArray(name) ? name : [name] });
    return this;
  }

  reloc(name?: string): this {
    this.actions.push({ action: 'reloc', name });
    return this;
  }

  export(name: string): this {
    this.actions.push({ action: 'export', name });
    return this;
  }

  exportzp(names: string | string[]): this {
    this.actions.push({ action: 'exportzp', names: Array.isArray(names) ? names : [names] });
    return this;
  }

  import(names: string | string[]): this {
    this.actions.push({ action: 'import', names: Array.isArray(names) ? names : [names] });
    return this;
  }

  importzp(names: string | string[]): this {
    this.actions.push({ action: 'importzp', names: Array.isArray(names) ? names : [names] });
    return this;
  }

  global(names: string | string[]): this {
    this.actions.push({ action: 'global', names: Array.isArray(names) ? names : [names] });
    return this;
  }

  globalzp(names: string | string[]): this {
    this.actions.push({ action: 'globalzp', names: Array.isArray(names) ? names : [names] });
    return this;
  }

  /** segment() + reloc() + label() + export(), for the common case of a relocatable
   * exported label. */
  relocExportLabel(name: string, segments?: string | string[]): this {
    if (segments) this.segment(segments);
    this.reloc();
    this.label(name);
    this.export(name);
    return this;
  }

  align(boundary: number, fill?: number): this {
    this.actions.push({ action: 'align', boundary, fill });
    return this;
  }

  res(count: number, value?: number): this {
    this.actions.push({ action: 'res', count, value });
    return this;
  }

  charmap(code: number, target: number): this {
    this.actions.push({ action: 'charmap', code, target });
    return this;
  }

  strmap(key: string, bytes: number | number[]): this {
    this.actions.push({ action: 'strmap', key, bytes: Array.isArray(bytes) ? bytes : [bytes] });
    return this;
  }

  pushCharmap(): this {
    this.actions.push({ action: 'pushcharmap' });
    return this;
  }

  popCharmap(): this {
    this.actions.push({ action: 'popcharmap' });
    return this;
  }

  assign(name: string, value: number): this {
    this.actions.push({ action: 'assign', name, value });
    return this;
  }

  set(name: string, value: number): this {
    this.actions.push({ action: 'set', name, value });
    return this;
  }

  free(size: number): this {
    this.actions.push({ action: 'free', size });
    return this;
  }
}

/**
 * Fluent entry point for building modules and compiling them programmatically. Wraps
 * compile() from libassembler.ts.
 */
export class AsmEngine {
  readonly modules: AsmModule[] = [];

  constructor(public options: Js65Options = {}, public callbacks?: FileCallbacks) {}

  add(mod: AsmModule): AsmModule {
    this.modules.push(mod);
    return mod;
  }

  module(name?: string): AsmModule {
    return this.add(new AsmModule(name));
  }

  compile(baseRom?: Uint8Array, signal?: CancelSignal): CompileResult {
    const inputs: AssemblyInput[] = this.modules.map(m => ({ type: 'actions', actions: m.actions, name: m.name }));
    return compile(inputs, this.options, this.callbacks, baseRom, signal);
  }
}
