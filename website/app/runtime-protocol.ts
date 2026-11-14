import type {SimulatorSnapshot} from '../../src/sim/machine.ts';

export interface RuntimeIdentity {workspaceVersion: number; targetId: string; sessionId: number}
export type RuntimeCommand =
  | {kind: 'load'; image: unknown}
  | {kind: 'run'; speed: number; budget: number}
  | {kind: 'pause'|'reset'|'step'|'back'|'nmi'}
  | {kind: 'irq'; value: boolean}
  | {kind: 'input'; value: number}
  | {kind: 'breakpoints'; addresses: number[]};
export type RuntimeRequest = RuntimeIdentity & {requestId: number; command: RuntimeCommand};
export type RuntimeResponse = RuntimeIdentity & {requestId: number; running: boolean;
  snapshot?: SimulatorSnapshot; error?: string};
