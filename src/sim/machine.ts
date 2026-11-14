import {Nmos6502} from './cpu.ts';
import type {MachineImage} from './loader.ts';

export type StopReason = 'paused'|'step'|'completed'|'breakpoint'|'budget'|'fault';
interface History {
  cpu: ReturnType<Nmos6502['state']>;
  seed: number;
  position: number;
  cursor: number;
  reason: StopReason;
  fault?: string;
  writes: Map<number, number>;
}
interface InputEvent {position: number; kind: 'input'|'irq'|'nmi'; value: number}

export class Simulator {
  readonly cpu = new Nmos6502();
  readonly breakpoints = new Set<number>();
  reason: StopReason = 'paused';
  fault?: string;
  seed = 1;
  position = 0;
  cursor = 0;
  private events: InputEvent[] = [];
  private eventStart = 0;
  private rewound = false;
  private history: History[] = [];
  private historyStart = 0;

  constructor(readonly image: MachineImage, readonly historyLimit = 4096) { this.initialize(); }

  reset(): void {
    this.initialize();
    this.cpu.reset();
  }

  private initialize(): void {
    this.cpu.memory.set(this.image.memory);
    this.cpu.restore({r: {pc: this.image.entry, a: 0, x: 0, y: 0, sp: 0xfd, p: 0x24, cycles: 0},
      irq: false, nmi: false, nmiLine: false});
    this.seed = 1;
    this.position = this.cursor = this.historyStart = 0;
    this.history = [];
    this.events = [];
    this.eventStart = 0;
    this.rewound = false;
    this.reason = 'paused';
    this.fault = undefined;
  }

  get historyAvailable(): number { return this.history.length - this.historyStart; }

  input(value: number): void {
    this.record('input', value & 255);
  }

  interrupt(kind: 'nmi'|'irq', value = true): void {
    this.record(kind, Number(value));
  }

  private record(kind: InputEvent['kind'], value: number): void {
    if (this.rewound) { this.events.splice(this.cursor - this.eventStart); this.rewound = false; }
    this.events.push({position: this.position, kind, value});
  }

  step(): boolean {
    if (this.cpu.r.pc === this.image.completion) { this.reason = 'completed'; return false; }
    if (this.reason === 'fault') return false;
    const state: History = {cpu: this.cpu.state(), seed: this.seed, position: this.position,
      cursor: this.cursor, reason: this.reason, fault: this.fault, writes: new Map()};
    this.cpu.onWrite = (address, previous) => {
      if (!state.writes.has(address)) state.writes.set(address, previous);
    };
    try {
      while (this.events[this.cursor - this.eventStart]?.position === this.position) {
        const event = this.events[this.cursor++ - this.eventStart];
        if (event.kind === 'input') this.cpu.write(0xff, event.value);
        else if (event.kind === 'irq') this.cpu.irq = !!event.value;
        else { this.cpu.setNmi(true); this.cpu.setNmi(false); }
      }
      if (!this.cpu.interruptPending) {
        this.seed ^= this.seed << 13; this.seed ^= this.seed >>> 17; this.seed ^= this.seed << 5;
        this.seed >>>= 0;
        this.cpu.write(0xfe, this.seed & 255);
      }
      this.cpu.step();
      this.position++;
      this.reason = this.cpu.r.pc === this.image.completion ? 'completed' : 'step';
    } catch (error) {
      this.reason = 'fault';
      this.fault = error instanceof Error ? error.message : String(error);
    } finally { this.cpu.onWrite = undefined; }
    this.history.push(state);
    if (this.historyAvailable > this.historyLimit) this.historyStart++;
    if (this.historyStart >= this.historyLimit) {
      this.history = this.history.slice(this.historyStart); this.historyStart = 0;
      const firstEvent = this.history[0]?.cursor ?? this.cursor;
      this.events.splice(0, firstEvent - this.eventStart);
      this.eventStart = firstEvent;
    }
    return this.reason !== 'fault';
  }

  back(): void {
    if (!this.historyAvailable) return;
    const state = this.history.pop()!;
    this.rewound = true;
    for (const [address, value] of state.writes) this.cpu.memory[address] = value;
    this.cpu.restore(state.cpu);
    this.seed = state.seed; this.position = state.position; this.cursor = state.cursor;
    this.reason = state.reason; this.fault = state.fault;
  }

  run(budget: number, skipBreakpoint = false): number {
    let executed = 0;
    while (executed < budget) {
      if (this.cpu.r.pc === this.image.completion) { this.reason = 'completed'; break; }
      if (this.breakpoints.has(this.cpu.r.pc) && !(skipBreakpoint && executed === 0)) {
        this.reason = 'breakpoint'; break;
      }
      if (!this.step()) break;
      executed++;
      if (this.reason === 'completed') break;
    }
    if (executed === budget && this.reason === 'step') this.reason = 'budget';
    return executed;
  }

  snapshot() {
    const pending = this.events.slice(this.cursor - this.eventStart).filter(event => event.position === this.position);
    const irq = pending.findLast(event => event.kind === 'irq');
    return {registers: {...this.cpu.r}, memory: this.cpu.memory.slice(), seed: this.seed,
      position: this.position, cursor: this.cursor, irq: irq ? !!irq.value : this.cpu.irq,
      nmi: this.cpu.nmi || pending.some(event => event.kind === 'nmi'),
      reason: this.reason, fault: this.fault, history: this.historyAvailable};
  }
}

export type SimulatorSnapshot = ReturnType<Simulator['snapshot']>;
