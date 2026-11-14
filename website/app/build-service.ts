import {Js65Worker} from '../../src/worker/client.ts';
import {browserHostPort} from '../../src/worker/port.ts';
import type {CompileResult} from '../../src/libassembler.ts';
import {simulatorTarget, type TargetDescriptor} from './targets.ts';

export interface BuildIdentity {
  workspaceVersion: number;
  targetId: string;
  requestId: number;
}

export class BuildService {
  private client?: Js65Worker;
  private worker?: Worker;
  private requestId = 0;

  constructor(private readonly url: URL, private readonly timeoutMs = 10000) {}

  async build(files: Map<string, string>, workspaceVersion: number,
    target: TargetDescriptor = simulatorTarget): Promise<{
    identity: BuildIdentity; result: CompileResult;
  }> {
    this.cancel();
    const identity: BuildIdentity = {workspaceVersion, targetId: target.id,
      requestId: ++this.requestId};
    const worker = this.worker = new Worker(this.url, {type: 'module'});
    const client = this.client = new Js65Worker(browserHostPort(worker));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        client.compile({files, request: {
          inputs: [{type: 'source', name: '/workspace/main.s',
            code: files.get('/workspace/main.s') ?? ''}],
          options: {target: target.compileTarget, generateListingFile: true,
            generateListingIndex: true, allowJavascript: false},
        }}),
        new Promise<never>((_, reject) => {
          worker.addEventListener('error', event => reject(new Error(event.message)));
          timer = setTimeout(() => reject(new Error('Build timed out. Edit the source to retry.')),
            this.timeoutMs);
        }),
      ]);
      return {identity, result};
    } finally {
      clearTimeout(timer);
      await client.terminate();
      if (this.client === client) { this.client = undefined; this.worker = undefined; }
    }
  }

  cancel(): void {
    void this.client?.terminate();
    this.worker?.terminate();
    this.client = undefined;
    this.worker = undefined;
  }
}
