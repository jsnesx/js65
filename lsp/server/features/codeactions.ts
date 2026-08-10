// SPDX-License-Identifier: MPL-2.0

/**
 * `textDocument/codeAction`: quick fixes for lint diagnostics.
 */

import type {Connection} from 'vscode-languageserver/node';
import type {
  CodeAction,
  CodeActionParams,
  Diagnostic,
  TextEdit,
} from 'vscode-languageserver-protocol';
import {CodeActionKind} from 'vscode-languageserver-protocol';

import type {MessageFix} from '../../../src/error.ts';
import {messageEditToTextEdit, pathToUri} from '../convert.ts';

export function registerCodeActionFeatures(connection: Connection): void {
  connection.onCodeAction((p): CodeAction[] => computeCodeActions(p));
}

/** Build the quick fixes for every diagnostic in the request's context. */
function computeCodeActions(p: CodeActionParams): CodeAction[] {
  const actions: CodeAction[] = [];
  for (const diagnostic of p.context.diagnostics) {
    const action = fixAction(diagnostic);
    if (action) actions.push(action);
  }
  return actions;
}

/** One `quickfix` action for a diagnostic carrying a fix, else undefined. */
function fixAction(diagnostic: Diagnostic): CodeAction|undefined {
  const fix = asFix(diagnostic.data);
  if (!fix) return undefined;
  // A fix can touch more than one file (the tail-call fix edits two lines, and
  // an include could put them in different files), so group by URI.
  const changes: Record<string, TextEdit[]> = {};
  for (const edit of fix.edits) {
    const uri = pathToUri(edit.file);
    (changes[uri] ??= []).push(messageEditToTextEdit(edit));
  }
  if (!Object.keys(changes).length) return undefined;
  return {
    title: fix.title,
    kind: CodeActionKind.QuickFix,
    diagnostics: [diagnostic],
    edit: {changes},
  };
}

/**
 * Narrow the untyped `Diagnostic.data` back to a `MessageFix`. It made a round
 * trip through the client as JSON, so nothing about its shape is guaranteed.
 */
function asFix(data: unknown): MessageFix|undefined {
  if (!data || typeof data !== 'object') return undefined;
  const fix = data as Partial<MessageFix>;
  if (typeof fix.title !== 'string' || !Array.isArray(fix.edits)) return undefined;
  return fix as MessageFix;
}

// Re-export for tests.
export {computeCodeActions};
