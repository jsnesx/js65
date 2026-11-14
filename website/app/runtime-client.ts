import type {RuntimeIdentity, RuntimeCommand, RuntimeResponse} from './runtime-protocol.ts';

export class RuntimeClient {
  private worker?: Worker;
  private sessionId = 0;
  private requestId = 0;
  private identity?: RuntimeIdentity;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly assets: URL, private readonly receive: (response: RuntimeResponse) => void,
    private readonly failed: (message: string) => void) {}

  start(workspaceVersion: number, targetId: string, workerFile: string): void {
    this.dispose();
    const identity = this.identity = {workspaceVersion, targetId, sessionId: ++this.sessionId};
    const worker = this.worker = new Worker(new URL(workerFile, this.assets), {type: 'module'});
    worker.onmessage = ({data}: MessageEvent<RuntimeResponse>) => {
      if (this.worker !== worker || data.sessionId !== identity.sessionId ||
          data.workspaceVersion !== identity.workspaceVersion || data.targetId !== identity.targetId ||
          data.requestId < this.requestId) return;
      clearTimeout(this.timer);
      this.receive(data);
    };
    worker.onerror = event => {
      if (this.worker !== worker) return;
      this.dispose(); this.failed(event.message || 'Runtime worker failed. Edit or reset to retry.');
    };
    worker.onmessageerror = () => {
      if (this.worker !== worker) return;
      this.dispose(); this.failed('Runtime response could not be read. Reset to retry.');
    };
  }

  send(command: RuntimeCommand): void {
    if (!this.worker || !this.identity) return;
    this.worker.postMessage({...this.identity, requestId: ++this.requestId, command});
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.dispose(); this.failed('Runtime stopped responding. Reset to retry.');
    }, 5000);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.worker?.terminate(); this.worker = undefined; this.identity = undefined;
  }
}
