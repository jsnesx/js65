import {Cpu} from '../../src/cpu.ts';
import type {SimulatorSnapshot} from '../../src/sim/machine.ts';
import type {ListingIndex, ListingRow} from '../../src/listing.ts';

export const palette = ['#000000', '#ffffff', '#880000', '#aaffee', '#cc44cc', '#00cc55',
  '#0000aa', '#eeee77', '#dd8855', '#664400', '#ff7777', '#333333', '#777777', '#aaff66', '#0088ff', '#bbbbbb'];
const hex = (n: number, width = 2) => n.toString(16).toUpperCase().padStart(width, '0');

export function sourceAddresses(index: ListingIndex, file: string, line: number): number[] {
  return [...new Set(index.rows.filter(row => row.instruction && row.address != null &&
    row.source?.file === file && row.source.line === line).map(row => row.address!))];
}

export class DebuggerView {
  private snapshot?: SimulatorSnapshot;
  private index?: ListingIndex;
  private readonly get: <T extends HTMLElement>(id: string) => T;
  private readonly context: CanvasRenderingContext2D;
  private readonly pixels: ImageData;
  private previousPixels?: Uint8Array;

  constructor(root: HTMLElement, private readonly associate: (row?: ListingRow) => void) {
    this.get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
    this.context = this.get<HTMLCanvasElement>('screen').getContext('2d', {willReadFrequently: true})!;
    this.pixels = this.context.createImageData(32, 32);
    this.get('memory-address').addEventListener('input', () => this.inspect());
  }

  artifact(index?: ListingIndex): void { this.index = index; }

  clear(): void {
    this.snapshot = undefined; this.index = undefined;
    for (const id of ['registers', 'current-instruction', 'memory', 'stack']) this.get(id).textContent = '';
    this.context.clearRect(0, 0, 32, 32);
    this.previousPixels = undefined;
    this.associate();
  }

  render(snapshot: SimulatorSnapshot, running: boolean): void {
    this.snapshot = snapshot;
    const r = snapshot.registers;
    const flags = [...'NV-BDIZC'].map((flag, i) => snapshot.registers.p & (128 >> i) ? flag : '.').join('');
    this.get('registers').textContent = `PC $${hex(r.pc, 4)}  A $${hex(r.a)}  X $${hex(r.x)}  Y $${hex(r.y)}  SP $${hex(r.sp)}  P $${hex(r.p)} ${flags}  Cycles ${r.cycles}`;
    this.get('runtime-status').textContent = `${running ? 'Running' : snapshot.reason}${snapshot.fault ? ': ' + snapshot.fault : ''}. History: ${snapshot.history} instructions. Seed: ${snapshot.seed}.`;
    this.get<HTMLButtonElement>('run').textContent = running ? 'Pause' : 'Run';
    this.get<HTMLButtonElement>('back').disabled = !snapshot.history;
    this.get('back').title = snapshot.history ? 'Restore the previous instruction state' : 'No retained history';
    this.get<HTMLInputElement>('irq').checked = snapshot.irq;
    const row = this.index?.rows.find(row => row.instruction && row.address === r.pc);
    const decoded = Cpu.P02.disasm(snapshot.memory[r.pc]);
    const value = snapshot.memory[(r.pc + 1) & 65535] | snapshot.memory[(r.pc + 2) & 65535] << 8;
    const instruction = decoded ? `${decoded[0]} ${Cpu.P02.format(decoded[1], Cpu.P02.argLen(decoded[1]) === 1 ? value & 255 : value)}` : 'unsupported opcode';
    const changed = row && row.bytes.some((b, i) => b !== snapshot.memory[(r.pc + i) & 65535]);
    this.get('current-instruction').textContent = `Live: $${hex(r.pc, 4)} ${instruction}\n${row?.source ? `${row.source.file}:${row.source.line}` : 'Unmapped source'}${changed ? ' (memory differs from assembly)' : ''}`;
    if (!running) this.associate(row);
    const display = snapshot.memory.subarray(0x200, 0x600);
    if (!this.previousPixels || display.some((byte, i) => byte !== this.previousPixels![i])) {
      for (let i = 0; i < 1024; i++) {
        const color = parseInt(palette[display[i] & 15].slice(1), 16);
        this.pixels.data.set([color >> 16, color >> 8 & 255, color & 255, 255], i * 4);
      }
      this.context.putImageData(this.pixels, 0, 0);
      this.previousPixels = display.slice();
    }
    this.inspect();
  }

  private inspect(): void {
    if (!this.snapshot) return;
    const memory = this.snapshot.memory;
    const dump = (start: number, count: number) => Array.from({length: count}, (_, row) => {
      const address = (start + row * 16) & 65535;
      return `$${hex(address, 4)}: ${Array.from({length: 16}, (_, i) => hex(memory[(address + i) & 65535])).join(' ')}`;
    }).join('\n');
    const input = this.get<HTMLInputElement>('memory-address');
    if (/^[0-9a-f]{1,4}$/i.test(input.value)) this.get('memory').textContent = dump(parseInt(input.value, 16), 8);
    this.get('stack').textContent = `Stack (SP $${hex(this.snapshot.registers.sp)})\n${dump(0x100, 16)}`;
  }
}
