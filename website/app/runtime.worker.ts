import {Simulator} from '../../src/sim/machine.ts';
import type {MachineImage} from '../../src/sim/loader.ts';
import type {RuntimeRequest, RuntimeResponse} from './runtime-protocol.ts';

const scope = globalThis as unknown as {onmessage: (event: MessageEvent<RuntimeRequest>) => void;
  postMessage: (response: RuntimeResponse) => void};
let machine: Simulator | undefined;
let request: RuntimeRequest;
let running = false, speed = 10000, remaining = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

function publish(error?: string): void {
  const {workspaceVersion, targetId, sessionId, requestId} = request;
  scope.postMessage({workspaceVersion, targetId, sessionId, requestId,
    running, snapshot: machine?.snapshot(), error});
}

function stop(): void { running = false; clearTimeout(timer); }

function batch(skip = false): void {
  if (!running || !machine) return;
  const count = Math.min(2000, Math.max(1, Math.floor(speed / 30)), remaining);
  const executed = machine.run(count, skip);
  remaining -= executed;
  if (machine.reason !== 'budget' || remaining <= 0) stop();
  publish();
  if (running) timer = setTimeout(batch, 33);
}

scope.onmessage = ({data}) => {
  if (data.command.kind !== 'load' && (!request || data.sessionId !== request.sessionId ||
      data.targetId !== request.targetId || data.workspaceVersion !== request.workspaceVersion)) return;
  request = data;
  const command = data.command;
  try {
    if (command.kind === 'load') { stop(); machine = new Simulator(command.image as MachineImage); }
    if (!machine) throw new Error('No machine loaded.');
    switch (command.kind) {
      case 'run': {
        stop(); running = true; speed = Math.max(1, Math.min(60000, command.speed));
        remaining = Math.max(1, Math.min(10000000, command.budget));
        batch(machine.reason === 'breakpoint'); return;
      }
      case 'pause': stop(); machine.reason = 'paused'; break;
      case 'reset': stop(); machine.reset(); break;
      case 'step': stop(); machine.step(); break;
      case 'back': stop(); machine.back(); break;
      case 'input': machine.input(command.value); break;
      case 'nmi': machine.interrupt('nmi'); break;
      case 'irq': machine.interrupt('irq', command.value); break;
      case 'breakpoints': machine.breakpoints.clear(); command.addresses.forEach(a => machine!.breakpoints.add(a)); break;
    }
    publish();
  } catch (error) { stop(); publish(error instanceof Error ? error.message : String(error)); }
};
