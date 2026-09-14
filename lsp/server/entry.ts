// SPDX-License-Identifier: MPL-2.0

import {
  createServerPipeTransport,
  createServerSocketTransport,
  IPCMessageReader,
  IPCMessageWriter,
  StreamMessageReader,
  StreamMessageWriter,
} from 'vscode-languageserver/node';
import type {MessageReader, MessageWriter} from 'vscode-languageserver-protocol';
import {parentPort, workerData} from 'node:worker_threads';

import {main} from './server.ts';
import {installNodeHost} from './nodehost.ts';
import type {WorkerPort} from '../../src/worker/port.ts';
import {serveLspWorker, type ServeOptions} from './worker/handler.ts';

type Transport = [MessageReader, MessageWriter];

/** Find which type of transport to use from the command line flags */
export function parseTransport(argv: string[]): Transport {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--stdio') {
      return [new StreamMessageReader(process.stdin), new StreamMessageWriter(process.stdout)];
    }
    if (arg === '--node-ipc') {
      return [new IPCMessageReader(process), new IPCMessageWriter(process)];
    }
    const [name, attached] = splitFlag(arg);
    if (name === '--socket') {
      const port = Number.parseInt(attached ?? argv[++i], 10);
      if (!Number.isInteger(port)) throw new Error(`js65 lsp: ${arg} needs a port number`);
      return createServerSocketTransport(port);
    }
    if (name === '--pipe') {
      const pipe = attached ?? argv[++i];
      if (!pipe) throw new Error(`js65 lsp: ${arg} needs a pipe name`);
      return createServerPipeTransport(pipe);
    }
    throw new Error(`js65 lsp: unknown option ${arg}`);
  }
  throw new Error(
      'js65 lsp: no transport given. Pass one of --stdio, --node-ipc, ' +
      '--socket=<port> or --pipe=<name>.');
}

function splitFlag(arg: string): [string, string | undefined] {
  const eq = arg.indexOf('=');
  return eq < 0 ? [arg, undefined] : [arg.slice(0, eq), arg.slice(eq + 1)];
}

/** Route the console away from stdout so it doesn't fight with --stdio transport */
function patchConsole(): void {
  const toStderr = (...args: unknown[]) => {
    process.stderr.write(`${args.map(String).join(' ')}\n`);
  };
  console.log = toStderr;
  console.info = toStderr;
  console.warn = toStderr;
  console.error = toStderr;
  console.debug = toStderr;
}

export async function runLspServer(argv: string[]): Promise<void> {
  const transport = parseTransport(argv);
  patchConsole();
  installNodeHost();
  await main({transport});
}

export function runLspWorker(): void {
  const parent = parentPort;
  if (!parent) {
    throw new Error('js65 lsp --worker must be loaded as a worker_threads worker');
  }
  installNodeHost();
  const port: WorkerPort = {
    post: (message, transfer) => parent.postMessage(message, transfer ?? []),
    onMessage: (handler) => parent.on('message', handler),
  };
  serveLspWorker(port, (workerData ?? {}) as ServeOptions);
}
