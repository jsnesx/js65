import {Cpu} from '../cpu.ts';

export interface Registers {
  pc: number; a: number; x: number; y: number; sp: number; p: number; cycles: number;
}

const C = 1, Z = 2, I = 4, D = 8, V = 64, N = 128;
export const documentedMnemonics = new Set(('adc and asl bcc bcs beq bit bmi bne bpl brk bvc bvs ' +
  'clc cld cli clv cmp cpx cpy dec dex dey eor inc inx iny jmp jsr lda ldx ldy lsr nop ora ' +
  'pha php pla plp rol ror rti rts sbc sec sed sei sta stx sty tax tay tsx txa txs tya').split(' '));
const readCycles = {imm: 2, zpg: 3, zpx: 4, zpy: 4, abs: 4, abx: 4,
  aby: 4, inx: 6, iny: 5, acc: 2, imp: 2, ind: 5, rel: 2};

export class Nmos6502 {
  r: Registers = {pc: 0, a: 0, x: 0, y: 0, sp: 0xfd, p: 0x24, cycles: 0};
  irq = false;
  nmi = false;
  nmiLine = false;
  private delayedI?: boolean;

  constructor(readonly memory = new Uint8Array(65536)) {}

  onWrite?: (address: number, previous: number) => void;

  write(address: number, value: number): void {
    this.onWrite?.(address, this.memory[address]);
    this.memory[address] = value;
  }

  private flag(mask: number, value: boolean): void {
    this.r.p = (value ? this.r.p | mask : this.r.p & ~mask) | 32;
  }

  private nz(value: number): number {
    value &= 255;
    this.flag(Z, value === 0);
    this.flag(N, !!(value & N));
    return value;
  }

  private fetch(): number {
    const value = this.memory[this.r.pc];
    this.r.pc = (this.r.pc + 1) & 65535;
    return value;
  }

  private word(address: number): number {
    return this.memory[address] | this.memory[(address + 1) & 65535] << 8;
  }

  private push(value: number): void {
    this.write(0x100 | this.r.sp, value);
    this.r.sp = (this.r.sp - 1) & 255;
  }

  private pull(): number {
    this.r.sp = (this.r.sp + 1) & 255;
    return this.memory[0x100 | this.r.sp];
  }

  setNmi(value: boolean): void {
    if (value && !this.nmiLine) this.nmi = true;
    this.nmiLine = value;
  }

  get interruptPending(): boolean {
    return this.nmi || this.irq && !(this.delayedI ?? !!(this.r.p & I));
  }

  reset(): void {
    this.r.sp = (this.r.sp - 3) & 255;
    this.r.p = (this.r.p | I | 32) & ~16;
    this.r.pc = this.word(0xfffc);
    this.r.cycles += 7;
    this.nmi = false;
    this.delayedI = undefined;
  }

  private interrupt(vector: number, brk = false): void {
    this.push(this.r.pc >> 8);
    this.push(this.r.pc);
    this.push((this.r.p & ~16) | 32 | (brk ? 16 : 0));
    this.r.p |= I;
    this.r.pc = this.word(vector);
    this.r.cycles += 7;
  }

  state(): {r: Registers; irq: boolean; nmi: boolean; nmiLine: boolean; delayedI?: boolean} {
    return {r: {...this.r}, irq: this.irq, nmi: this.nmi,
      nmiLine: this.nmiLine, delayedI: this.delayedI};
  }

  restore(state: ReturnType<Nmos6502['state']>): void {
    this.r = {...state.r};
    this.irq = state.irq;
    this.nmi = state.nmi;
    this.nmiLine = state.nmiLine;
    this.delayedI = state.delayedI;
  }

  private arithmetic(value: number, subtract: boolean): void {
    const a = this.r.a, carry = this.r.p & C;
    const sum = a + (subtract ? value ^ 255 : value) + carry;
    let result = sum;
    this.flag(Z, (sum & 255) === 0);
    if (this.r.p & D) {
      if (subtract) {
        let lo = (a & 15) - (value & 15) + carry - 1;
        if (lo < 0) lo = ((lo - 6) & 15) - 16;
        result = (a & 240) - (value & 240) + lo;
        if (result < 0) result -= 0x60;
        this.flag(N, !!(sum & N));
        this.flag(V, !!((a ^ value) & (a ^ sum) & 128));
        this.flag(C, sum > 255);
      } else {
        let lo = (a & 15) + (value & 15) + carry;
        if (lo > 9) lo = ((lo + 6) & 15) + 16;
        result = (a & 240) + (value & 240) + lo;
        this.flag(N, !!(result & N));
        this.flag(V, !!(~(a ^ value) & (a ^ result) & 128));
        if (result >= 0xa0) result += 0x60;
        this.flag(C, result > 255);
      }
    } else {
      this.flag(N, !!(sum & N));
      this.flag(V, !!((subtract ? a ^ value : ~(a ^ value)) & (a ^ sum) & 128));
      this.flag(C, sum > 255);
    }
    this.r.a = result & 255;
  }

  step(): void {
    const masked = this.delayedI ?? !!(this.r.p & I);
    this.delayedI = undefined;
    if (this.nmi || this.irq && !masked) {
      const vector = this.nmi ? 0xfffa : 0xfffe;
      this.nmi = false;
      this.interrupt(vector);
      return;
    }
    const opcode = this.memory[this.r.pc];
    const decoded = Cpu.P02.disasm(opcode);
    if (!decoded || !documentedMnemonics.has(decoded[0])) throw new Error(`Unsupported opcode $${opcode.toString(16).padStart(2, '0')} at $${this.r.pc.toString(16).padStart(4, '0')}`);
    const [op, mode] = decoded;
    this.fetch();
    let address = 0, base = 0, crossed = false;
    const word = () => this.fetch() | this.fetch() << 8;
    switch (mode) {
      case 'imm': address = this.r.pc; this.fetch(); break;
      case 'zpg': address = this.fetch(); break;
      case 'zpx': address = (this.fetch() + this.r.x) & 255; break;
      case 'zpy': address = (this.fetch() + this.r.y) & 255; break;
      case 'abs': address = word(); break;
      case 'abx': case 'aby':
        base = word(); address = (base + (mode === 'abx' ? this.r.x : this.r.y)) & 65535;
        crossed = (base & 0xff00) !== (address & 0xff00); break;
      case 'inx':
        base = (this.fetch() + this.r.x) & 255;
        address = this.memory[base] | this.memory[(base + 1) & 255] << 8; break;
      case 'iny':
        base = this.fetch(); base = this.memory[base] | this.memory[(base + 1) & 255] << 8;
        address = (base + this.r.y) & 65535;
        crossed = (base & 0xff00) !== (address & 0xff00); break;
      case 'ind':
        base = word(); address = this.memory[base] | this.memory[(base & 0xff00) | ((base + 1) & 255)] << 8; break;
      case 'rel': base = this.fetch(); address = (this.r.pc + (base < 128 ? base : base - 256)) & 65535; break;
    }
    const value = this.memory[address];
    let cycles = readCycles[mode];
    const store = op === 'sta' || op === 'stx' || op === 'sty';
    const modify = ['asl', 'lsr', 'rol', 'ror', 'inc', 'dec'].includes(op) && mode !== 'acc' && mode !== 'imp';
    if (store && ['abx', 'aby', 'iny'].includes(mode)) cycles++;
    else if (modify) cycles += ['abx', 'aby'].includes(mode) ? 3 : 2;
    else if (crossed) cycles++;
    const compare = (register: number) => {
      this.flag(C, register >= value); this.nz(register - value);
    };
    const branch = (take: boolean) => {
      if (!take) return;
      cycles += 1 + ((this.r.pc & 0xff00) !== (address & 0xff00) ? 1 : 0);
      this.r.pc = address;
    };
    switch (op) {
      case 'adc': this.arithmetic(value, false); break;
      case 'sbc': this.arithmetic(value, true); break;
      case 'and': this.r.a = this.nz(this.r.a & value); break;
      case 'ora': this.r.a = this.nz(this.r.a | value); break;
      case 'eor': this.r.a = this.nz(this.r.a ^ value); break;
      case 'lda': this.r.a = this.nz(value); break;
      case 'ldx': this.r.x = this.nz(value); break;
      case 'ldy': this.r.y = this.nz(value); break;
      case 'sta': this.write(address, this.r.a); break;
      case 'stx': this.write(address, this.r.x); break;
      case 'sty': this.write(address, this.r.y); break;
      case 'cmp': compare(this.r.a); break;
      case 'cpx': compare(this.r.x); break;
      case 'cpy': compare(this.r.y); break;
      case 'bit': this.flag(Z, !(this.r.a & value)); this.flag(N, !!(value & N)); this.flag(V, !!(value & V)); break;
      case 'asl': case 'lsr': case 'rol': case 'ror': {
        const accumulator = mode === 'acc' || mode === 'imp';
        const old = accumulator ? this.r.a : value, carry = this.r.p & C;
        this.flag(C, !!(old & (op === 'asl' || op === 'rol' ? 128 : 1)));
        const next = this.nz(op === 'asl' ? old << 1 : op === 'lsr' ? old >> 1 :
          op === 'rol' ? old << 1 | carry : old >> 1 | carry << 7);
        if (accumulator) this.r.a = next; else this.write(address, next);
        break;
      }
      case 'inc': this.write(address, this.nz(value + 1)); break;
      case 'dec': this.write(address, this.nz(value - 1)); break;
      case 'inx': this.r.x = this.nz(this.r.x + 1); break;
      case 'iny': this.r.y = this.nz(this.r.y + 1); break;
      case 'dex': this.r.x = this.nz(this.r.x - 1); break;
      case 'dey': this.r.y = this.nz(this.r.y - 1); break;
      case 'tax': this.r.x = this.nz(this.r.a); break;
      case 'tay': this.r.y = this.nz(this.r.a); break;
      case 'txa': this.r.a = this.nz(this.r.x); break;
      case 'tya': this.r.a = this.nz(this.r.y); break;
      case 'tsx': this.r.x = this.nz(this.r.sp); break;
      case 'txs': this.r.sp = this.r.x; break;
      case 'pha': this.push(this.r.a); cycles = 3; break;
      case 'php': this.push(this.r.p | 48); cycles = 3; break;
      case 'pla': this.r.a = this.nz(this.pull()); cycles = 4; break;
      case 'plp': this.delayedI = !!(this.r.p & I); this.r.p = (this.pull() & ~16) | 32; cycles = 4; break;
      case 'jmp': this.r.pc = address; cycles = mode === 'ind' ? 5 : 3; break;
      case 'jsr': base = (this.r.pc - 1) & 65535; this.push(base >> 8); this.push(base); this.r.pc = address; cycles = 6; break;
      case 'rts': this.r.pc = ((this.pull() | this.pull() << 8) + 1) & 65535; cycles = 6; break;
      case 'rti': this.r.p = (this.pull() & ~16) | 32; this.r.pc = this.pull() | this.pull() << 8; cycles = 6; break;
      case 'brk': this.fetch(); this.interrupt(0xfffe, true); cycles = 0; break;
      case 'bcc': branch(!(this.r.p & C)); break;
      case 'bcs': branch(!!(this.r.p & C)); break;
      case 'beq': branch(!!(this.r.p & Z)); break;
      case 'bne': branch(!(this.r.p & Z)); break;
      case 'bmi': branch(!!(this.r.p & N)); break;
      case 'bpl': branch(!(this.r.p & N)); break;
      case 'bvc': branch(!(this.r.p & V)); break;
      case 'bvs': branch(!!(this.r.p & V)); break;
      case 'clc': this.flag(C, false); break;
      case 'sec': this.flag(C, true); break;
      case 'cld': this.flag(D, false); break;
      case 'sed': this.flag(D, true); break;
      case 'clv': this.flag(V, false); break;
      case 'cli': case 'sei': this.delayedI = !!(this.r.p & I); this.flag(I, op === 'sei'); break;
      case 'nop': break;
      default: throw new Error(`Unsupported instruction ${op}`);
    }
    this.r.cycles += cycles;
  }
}
