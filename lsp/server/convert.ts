// SPDX-License-Identifier: MPL-2.0

/**
 * Convert.ts is for converting and managing file paths between the source on disk
 * and the file paths used in js65.
 */

import type {AssemblerMessage, MessageEdit, SourceInfo} from '../../src/error.ts';
import type {
  Diagnostic,
  DiagnosticSeverity,
  DiagnosticRelatedInformation,
  Location,
  Position,
  Range,
  TextEdit,
} from 'vscode-languageserver-protocol';
import {URI} from 'vscode-uri';

/** Severity mapping for `ErrorLevel`. */
const SEVERITY_MAP: Record<AssemblerMessage['level'], DiagnosticSeverity> = {
  error: 1,
  warning: 2,
  info: 3,
};

/** URI scheme for the read-only view of a bundled jsmodule's original source. */
export const JSMODULE_SCHEME = 'js65-jsmodule';

const JSMODULE_PATH = /^<jsmodule ([A-Za-z_$][\w$]*)>\/(.+)$/;

export function pathToUri(path: string): string {
  if (!path) return '';
  // A jsmodule is bundled into js65 rather than read from disk, so it gets a
  // URI the client serves read-only instead of a file:// path resolving nowhere.
  const m = JSMODULE_PATH.exec(path);
  if (m) return `${JSMODULE_SCHEME}:/${m[1]}/${m[2]}`;
  return URI.file(path).toString();
}

/** Splits a `js65-jsmodule:` URI back into the module and one of its sources. */
export function jsModuleSourceOf(uri: string): {module: string, source: string} | undefined {
  const parsed = URI.parse(uri);
  if (parsed.scheme !== JSMODULE_SCHEME) return undefined;
  const [, module, ...rest] = parsed.path.split('/');
  if (!module || !rest.length) return undefined;
  return {module, source: rest.join('/')};
}

export function uriToPath(uri: string): string {
  const parsed = URI.parse(uri);
  return parsed.fsPath;
}

/**
 * Converts from js65's line/column to the  LSP range
 * js65 `line` is 1-based, `column` is 0-based
 * LSP `line` and `character` are 0-based and the end position is exclusive.
 */
export function sourceInfoToRange(info: SourceInfo): Range {
  const startLine = Math.max(0, info.line - 1);
  const startChar = Math.max(0, info.column);
  const endLine = info.endLine != null ? Math.max(0, info.endLine - 1) : startLine;
  const endChar = info.endColumn != null ? Math.max(0, info.endColumn) : startChar;
  return {
    start: {line: startLine, character: startChar},
    end: {line: endLine, character: endChar},
  };
}

/**
 * Converts a lint fix edit to an LSP text edit. 
 * `MessageEdit` uses the same convention as `SourceInfo`: 1-based line, 0-based column.
 */
export function messageEditToTextEdit(edit: MessageEdit): TextEdit {
  return {
    range: {
      start: {line: Math.max(0, edit.startLine - 1), character: Math.max(0, edit.startColumn)},
      end: {line: Math.max(0, edit.endLine - 1), character: Math.max(0, edit.endColumn)},
    },
    newText: edit.newText,
  };
}

/** Build a `Location` from a path-resolved `SourceInfo`. */
export function sourceInfoToLocation(info: SourceInfo, uriOf: (path: string) => string): Location {
  return {
    uri: uriOf(info.file),
    range: sourceInfoToRange(info),
  };
}

/**
 * Convert one assembler message into an LSP diagnostic
 * Walks the list of "expanded from here" messages to include it with the parent message
 */
export function messageToDiagnostic(
    msg: AssemblerMessage,
    uriOf: (path: string) => string,
): Diagnostic {
  const source = msg.source;
  const range: Range = source
      ? sourceInfoToRange(source)
      // No position at all (e.g. the "too many errors" sentinel). Cover the
      // first line of whatever file owns the message, or [0,0]-[0,0] if there's
      // nothing better.
      : {start: {line: 0, character: 0}, end: {line: 0, character: 0}};
  const related: DiagnosticRelatedInformation[] = [];
  for (let p = source?.parent; p; p = p.parent) {
    related.push({
      location: {
        uri: uriOf(p.file),
        range: sourceInfoToRange(p),
      },
      message: 'expanded from here',
    });
  }
  const diagnostic: Diagnostic = {
    severity: SEVERITY_MAP[msg.level],
    range,
    message: msg.message,
    source: 'js65',
  };
  if (related.length) diagnostic.relatedInformation = related;
  // Lint rule id, shown by the client next to the message.
  if (msg.code != null) diagnostic.code = msg.code;
  // The fix rides along in `data`, which the client hands back verbatim on
  // `textDocument/codeAction`, so the quick fix needs no re-analysis.
  if (msg.fix) diagnostic.data = msg.fix;
  return diagnostic;
}

/** Build a zero-width range at a single LSP position. */
export function rangeAtPosition(pos: Position): Range {
  return {start: pos, end: pos};
}

export function rangeContains(outer: Range, inner: Position): boolean {
  const s = outer.start, e = outer.end;
  if (inner.line < s.line || inner.line > e.line) return false;
  if (inner.line === s.line && inner.character < s.character) return false;
  if (inner.line === e.line && inner.character >= e.character) return false;
  return true;
}
