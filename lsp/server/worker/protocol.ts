// SPDX-License-Identifier: MPL-2.0

import type {Diagnostic} from 'vscode-languageserver-protocol';
import type {Js65Config} from '../project.ts';
import type {FileDelta, FileSnapshot} from './filecache.ts';

export const LSP_PROTOCOL_VERSION = 1;

/** Feature requests the worker answers. Each maps to one compute function. */
export type FeatureMethod =
  | 'textDocument/definition'
  | 'textDocument/references'
  | 'textDocument/documentSymbol'
  | 'workspace/symbol'
  | 'textDocument/hover'
  | 'textDocument/completion'
  | 'textDocument/foldingRange'
  | 'textDocument/semanticTokens/full'
  | 'js65/expandMacro';

interface Envelope {
  v: typeof LSP_PROTOCOL_VERSION;
  id: number;
}

export interface PingRequest extends Envelope { kind: 'ping'; }

/** An LSP feature request forwarded verbatim; the worker picks the compute function. */
export interface FeatureRequest extends Envelope {
  kind: 'feature';
  method: FeatureMethod;
  params: unknown;
}

/** Document lifecycle, mirrored so the worker's open-buffer layer wins over disk. */
export interface DocRequest extends Envelope {
  kind: 'doc';
  op: 'open' | 'change' | 'close';
  uri: string;
  text?: string;
  version?: number;
}

/** Whole-cache replacement, sent on project load and reload. */
export interface FilesRequest extends Envelope {
  kind: 'files';
  snapshot: FileSnapshot;
}

/** Incremental cache update. What keeps a keystroke from re-posting the project. */
export interface FileDeltaRequest extends Envelope {
  kind: 'fileDelta';
  delta: FileDelta;
}

/** The project config, discovered host-side because discovery is all sync disk I/O. */
export interface ProjectRequest extends Envelope {
  kind: 'project';
  config: Js65Config | undefined;
  workspaceRoot: string;
}

/**
 * The workspace root on its own. `initialize` always knows the root, but a project only
 * arrives when there is a `js65.json`, and standalone include resolution needs the root too.
 */
export interface WorkspaceRootRequest extends Envelope {
  kind: 'workspaceRoot';
  workspaceRoot: string;
}

/** Re-link the projects owning a saved file, as `linkSaved` does today. */
export interface LinkSavedRequest extends Envelope {
  kind: 'linkSaved';
  uri: string;
}

export type LspReq = PingRequest | FeatureRequest | DocRequest | FilesRequest
                   | FileDeltaRequest | ProjectRequest | WorkspaceRootRequest
                   | LinkSavedRequest;

export interface LspOkResponse extends Envelope {
  ok: true;
  value: unknown;
}

export interface LspErrResponse extends Envelope {
  ok: false;
  error: {name: string, message: string, stack?: string};
}

export interface DiagnosticsNotification {
  v: typeof LSP_PROTOCOL_VERSION;
  kind: 'diagnostics';
  /** `AnalysisResult.diagnostics` flattened; `projects` never crosses. */
  diagnostics: [string, Diagnostic[]][];
  touchedUris: string[];
}

/**
 * Line ranges the preprocessor skipped, so the editor can grey them out the way
 * a C editor greys out an untaken `#if`.
 */
export interface InactiveRegionsNotification {
  v: typeof LSP_PROTOCOL_VERSION;
  kind: 'inactiveRegions';
  /** URI -> the 0-based, end-exclusive line spans to dim in that file. */
  regions: [string, Array<{startLine: number, endLine: number}>][];
}

/** Analyzer log output, surfaced through the connection console on the host. */
export interface LogNotification {
  v: typeof LSP_PROTOCOL_VERSION;
  kind: 'log';
  message: string;
}

export type LspRes = LspOkResponse | LspErrResponse | DiagnosticsNotification
                   | InactiveRegionsNotification | LogNotification;

/** Narrows a worker message to a response with an `id`, i.e. not a notification. */
export function isLspResponse(res: LspRes): res is LspOkResponse | LspErrResponse {
  return 'id' in res;
}

export function toLspError(err: unknown): LspErrResponse['error'] {
  const isError = err instanceof Error;
  return {
    name: isError ? err.name : 'Error',
    message: isError ? err.message : String(err),
    stack: isError ? err.stack : undefined,
  };
}

export function fromLspError(wire: LspErrResponse['error']): Error {
  const err = new Error(wire.message);
  err.name = wire.name;
  if (wire.stack) err.stack = wire.stack;
  return err;
}
