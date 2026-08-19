// SPDX-License-Identifier: MPL-2.0

import type {Diagnostic} from 'vscode-languageserver-protocol';

import type {HostPort} from '../../src/worker/port.ts';
import type {FileDelta, FileSnapshot} from './worker/filecache.ts';
import type {Js65Config} from './project.ts';
import {LSP_PROTOCOL_VERSION, fromLspError, isLspResponse, type FeatureMethod,
        type LspRes} from './worker/protocol.ts';

/** What the host does with a diagnostics push. */
export interface AnalyzerDiagnostics {
  diagnostics: Map<string, Diagnostic[]>;
  touchedUris: Set<string>;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: unknown) => void;
}

export class LspWorkerClient {
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private readonly handshake: Promise<void>;
  private closed?: Error;

  /** Called when the worker finishes an analysis pass. */
  onDiagnostics?: (result: AnalyzerDiagnostics) => void;
  /** Called for analyzer log output, which the host frames as `window/logMessage`. */
  onLog?: (message: string) => void;

  constructor(private readonly port: HostPort) {
    this.port.onMessage((message) => this.receive(message));
    this.handshake = this.ping();
    // Nothing awaits ready() yet; the rejection is still delivered to whoever does later.
    this.handshake.catch(() => {});
  }

  ready(): Promise<void> {
    return this.handshake;
  }

  setFiles(snapshot: FileSnapshot): void {
    this.post({kind: 'files', snapshot});
  }

  applyFileDelta(delta: FileDelta): void {
    this.post({kind: 'fileDelta', delta});
  }

  /**
   * The workspace root alone, sent at `initialize`. A workspace with no `js65.json` never
   * sends a project, and standalone include resolution still searches the root.
   */
  setWorkspaceRoot(workspaceRoot: string): void {
    this.post({kind: 'workspaceRoot', workspaceRoot});
  }

  setProject(config: Js65Config | undefined, workspaceRoot: string): void {
    this.post({kind: 'project', config, workspaceRoot});
  }

  open(uri: string, text: string, version?: number): void {
    this.post({kind: 'doc', op: 'open', uri, text, version});
  }

  change(uri: string, text: string, version?: number): void {
    this.post({kind: 'doc', op: 'change', uri, text, version});
  }

  close(uri: string): void {
    this.post({kind: 'doc', op: 'close', uri});
  }

  async linkSaved(uri: string): Promise<void> {
    await this.send({kind: 'linkSaved', uri});
  }

  /** Forward one LSP feature request and hand back whatever the worker computed. */
  async request<T>(method: FeatureMethod, params: unknown): Promise<T> {
    await this.handshake;
    return await this.send({kind: 'feature', method, params}) as T;
  }

  async terminate(): Promise<void> {
    this.fail(new Error('Analyzer worker terminated'));
    await this.port.terminate();
  }

  private async ping(): Promise<void> {
    const value = await this.send({kind: 'ping'}) as {v: number};
    if (value?.v !== LSP_PROTOCOL_VERSION) {
      const err = new Error(
          `Analyzer worker protocol version ${value?.v} does not match host ` +
          `${LSP_PROTOCOL_VERSION}. The worker bundle is probably stale.`);
      this.fail(err);
      throw err;
    }
  }

  private post(body: Record<string, unknown>): void {
    this.send(body).catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      this.onLog?.(`js65-lsp: dropped ${body.kind} for the analyzer worker: ${detail}`);
    });
  }

  private send(body: Record<string, unknown>): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, {resolve, reject});
      try {
        this.port.post({v: LSP_PROTOCOL_VERSION, id, ...body});
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  private receive(message: unknown): void {
    const res = message as LspRes;
    if (!res || typeof res !== 'object') return;
    if (!isLspResponse(res)) {
      if (res.kind === 'diagnostics') {
        this.onDiagnostics?.({
          diagnostics: new Map(res.diagnostics),
          touchedUris: new Set(res.touchedUris),
        });
      } else if (res.kind === 'log') {
        this.onLog?.(res.message);
      }
      return;
    }
    const pending = this.pending.get(res.id);
    if (!pending) return;
    this.pending.delete(res.id);
    if (res.ok) pending.resolve(res.value);
    else pending.reject(fromLspError(res.error));
  }

  private fail(err: Error): void {
    this.closed = err;
    for (const pending of this.pending.values()) pending.reject(err);
    this.pending.clear();
  }
}
