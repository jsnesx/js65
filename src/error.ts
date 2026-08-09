
// SPDX-License-Identifier: MPL-2.0

export interface SourceInfo {
  ident?: string;
  file: string;
  line: number;
  column: number;
  /** macro-expansion / include stack */
  parent?: SourceInfo;
  // Added for the LSP, so its only used in server mode for now.
  endLine?: number;
  endColumn?: number;
}

export type ErrorLevel = 'info' | 'warning' | 'error';

export interface MessageEdit {
  file: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  newText: string;
}

/** A machine-applicable fix for a message, consumed by the LSP. */
export interface MessageFix {
  title: string;
  edits: MessageEdit[];
}

export interface AssemblerMessage {
  /** Severity of the message */
  level: ErrorLevel;
  /** Human-readable message */
  message: string;
  /** Source location where message originated */
  source?: SourceInfo;
  /** JS stack trace when captured */
  stack?: string;
  /** Lint rule id or undefined if its not a linter message */
  code?: string;
  /** Machine-applicable fix, used by the LSP */
  fix?: MessageFix;
}

export function at(arg: {source?: SourceInfo}): string {
  const s = arg.source;
  if (!s) return '';
  const parent = s.parent ? at({source: s.parent}) : '';
  return `\n  at ${s.file}:${s.line}:${s.column}${parent}`;
  // TODO - definition vs usage?
}

export class SourceError extends Error {
  readonly source?: SourceInfo;
  /** Tracks if this has already been reported to stop this from getting posted twice. */
  recorded = false;
  constructor(message: string, at?: {source?: SourceInfo}|SourceInfo) {
    super(message);
    this.name = 'SourceError';
    // `at` is either a SourceInfo or something carrying one (usually a Token).
    const source = !at ? undefined :
        'source' in at ? at.source :
        'file' in at ? at as SourceInfo : undefined;
    if (source) this.source = source;
  }

  /** Add a stack to the error if we haven't gotten that resolved yet. */
  static locate(err: unknown, source?: SourceInfo): unknown {
    if (!source || !(err instanceof Error) || err instanceof SourceError) return err;
    const located = new SourceError(err.message, source);
    located.stack = err.stack;
    return located;
  }
}

// Helper function to create a source error from the message + sourceinfo
export function fail(message: string, at?: {source?: SourceInfo}|SourceInfo): never {
  throw new SourceError(message, at);
}

export class RecoverableError extends SourceError {
  constructor(message: string, source?: SourceInfo) {
    super(message, source);
    this.name = 'RecoverableError';
    this.recorded = true;
  }
}

export class FatalError extends SourceError {
  constructor(message: string, at?: {source?: SourceInfo}|SourceInfo) {
    super(message, at);
    this.name = 'FatalError';
  }
}

/** How many errors a single collector reports before giving up. */
export const DEFAULT_ERROR_LIMIT = 30;

export class ErrorCollector {
  private messages: AssemblerMessage[] = [];
  private errorCount = 0;

  limit: number;

  /** @param limit Maximum number of errors to report; 0 for unlimited. */
  constructor(limit: number = DEFAULT_ERROR_LIMIT) {
    this.limit = limit;
  }

  add(level: ErrorLevel, message: string, source?: SourceInfo,
      extra?: {code?: string, fix?: MessageFix}): void {
    this.messages.push({
      level,
      message,
      source,
      stack: new Error().stack,
      ...extra,
    });
    this.checkLimit(level);
  }

  addFromException(err: Error, source?: SourceInfo, level: ErrorLevel = 'error'): void {
    this.messages.push({
      level,
      message: err.message,
      source: (err instanceof SourceError ? err.source : undefined) ?? source,
      stack: err.stack,
    });
    this.checkLimit(level);
  }

  private checkLimit(level: ErrorLevel): void {
    if (level !== 'error') return;
    if (!this.limit || ++this.errorCount < this.limit) return;
    const message = `too many errors (${this.limit}); stopping`;
    this.messages.push({level: 'error', message});
    const err = new FatalError(message);
    err.recorded = true;
    throw err;
  }

  getMessages(): readonly AssemblerMessage[] {
    return this.messages;
  }

  hasErrors(): boolean {
    return this.messages.some(m => m.level === 'error');
  }

  clear(): void {
    this.messages = [];
    this.errorCount = 0;
  }
}
