// Generated from instructionreference.wiki by website/gen-instructions.ts.
import type {InstructionReference} from '../tools/instruction-reference.ts';

export const instructionReference: Record<string, InstructionReference> = {
  "adc": {
    "name": "Add with Carry",
    "operation": "A = A + memory + C",
    "description": "ADC adds the carry flag and a memory value to the accumulator. The carry flag is then set to the carry value coming out of bit 7, allowing values larger than 1 byte to be added together by carrying the 1 into the next byte's addition. This can also be thought of as unsigned overflow. It is common to clear carry with CLC before adding the first byte to ensure it is in a known state, avoiding an off-by-one error. The overflow flag indicates whether signed overflow or underflow occurred. This happens if both inputs are positive and the result is negative, or both are negative and the result is positive.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "result > $FF",
        "notes": "If the result overflowed past $FF (wrapping around), unsigned overflow occurred."
      },
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "V - Overflow",
        "value": "(result ^ A) & (result ^ memory) & $80",
        "notes": "If the result's sign is different from both A's and memory's, signed overflow (or underflow) occurred."
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imm",
        "addressingMode": "#Immediate",
        "opcode": 105,
        "bytes": 2,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 101,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 117,
        "bytes": 2,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 109,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 125,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "aby",
        "addressingMode": "Absolute,Y",
        "opcode": 121,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "inx",
        "addressingMode": "(Indirect,X)",
        "opcode": 97,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "iny",
        "addressingMode": "(Indirect),Y",
        "opcode": 113,
        "bytes": 2,
        "cycles": "5 (6 if page crossed)",
        "notes": ""
      }
    ]
  },
  "and": {
    "name": "Bitwise AND",
    "operation": "A = A & memory",
    "description": "This ANDs a memory value and the accumulator, bit by bit. If both input bits are 1, the resulting bit is 1. Otherwise, it is 0.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imm",
        "addressingMode": "#Immediate",
        "opcode": 41,
        "bytes": 2,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 37,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 53,
        "bytes": 2,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 45,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 61,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "aby",
        "addressingMode": "Absolute,Y",
        "opcode": 57,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "inx",
        "addressingMode": "(Indirect,X)",
        "opcode": 33,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "iny",
        "addressingMode": "(Indirect),Y",
        "opcode": 49,
        "bytes": 2,
        "cycles": "5 (6 if page crossed)",
        "notes": ""
      }
    ]
  },
  "asl": {
    "name": "Arithmetic Shift Left",
    "operation": "value = value << 1 , or visually: C <- [76543210] <- 0",
    "description": "ASL shifts all the bits of a memory value or the accumulator one position to the left, moving the value of each bit into the next bit. Bit 7 is shifted into the carry flag, and 0 is shifted into bit 0. This is equivalent to multiplying an unsigned value by 2, with carry indicating overflow.\n\nThis is a read-modify-write instruction, meaning that its addressing modes that operate on memory first write the original value back to memory before the modified value. This extra write can matter if targeting a hardware register.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "value bit 7",
        "notes": ""
      },
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "acc",
        "addressingMode": "Accumulator",
        "opcode": 10,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 6,
        "bytes": 2,
        "cycles": "5",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 22,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 14,
        "bytes": 3,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 30,
        "bytes": 3,
        "cycles": "7",
        "notes": ""
      }
    ]
  },
  "bcc": {
    "name": "Branch if Carry Clear",
    "operation": "PC = PC + 2 + memory (signed)",
    "description": "If the carry flag is clear, BCC branches to a nearby location by adding the relative offset to the program counter. The offset is signed and has a range of [-128, 127] relative to the first byte after the branch instruction. Branching further than that requires using a JMP instruction, instead, and branching over that JMP when carry is set with BCS.\n\nThe carry flag has different meanings depending on the context. BCC can be used after a compare to branch if the register is less than the memory value, so it is sometimes called BLT for Branch if Less Than. It can also be used after SBC to branch if the unsigned value underflowed or after ADC to branch if it did not overflow.",
    "flags": [],
    "encodings": [
      {
        "mode": "rel",
        "addressingMode": "Relative",
        "opcode": 144,
        "bytes": 2,
        "cycles": "2 (3 if branch taken, 4 if page crossed)",
        "notes": ""
      }
    ]
  },
  "bcs": {
    "name": "Branch if Carry Set",
    "operation": "PC = PC + 2 + memory (signed)",
    "description": "If the carry flag is set, BCS branches to a nearby location by adding the branch offset to the program counter. The offset is signed and has a range of [-128, 127] relative to the first byte after the branch instruction. Branching further than that requires using a JMP instruction, instead, and branching over that JMP when carry is clear with BCC.\n\nThe carry flag has different meanings depending on the context. BCS can be used after a compare to branch if the register is greater than or equal to the memory value, so it is sometimes called BGE for Branch if Greater Than or Equal. It can also be used after ADC to branch if the unsigned value overflowed or after SBC to branch if it did not underflow.",
    "flags": [],
    "encodings": [
      {
        "mode": "rel",
        "addressingMode": "Relative",
        "opcode": 176,
        "bytes": 2,
        "cycles": "2 (3 if branch taken, 4 if page crossed)",
        "notes": ""
      }
    ]
  },
  "beq": {
    "name": "Branch if Equal",
    "operation": "PC = PC + 2 + memory (signed)",
    "description": "If the zero flag is set, BEQ branches to a nearby location by adding the branch offset to the program counter. The offset is signed and has a range of [-128, 127] relative to the first byte after the branch instruction. Branching further than that requires using a JMP instruction, instead, and branching over that JMP when zero is clear with BNE.\n\nComparison uses this flag to indicate if the compared values are equal. All instructions that change A, X, or Y also implicitly set or clear the zero flag depending on whether the register becomes 0.",
    "flags": [],
    "encodings": [
      {
        "mode": "rel",
        "addressingMode": "Relative",
        "opcode": 240,
        "bytes": 2,
        "cycles": "2 (3 if branch taken, 4 if page crossed)",
        "notes": ""
      }
    ]
  },
  "bit": {
    "name": "Bit Test",
    "operation": "A & memory",
    "description": "BIT modifies flags, but does not change memory or registers. The zero flag is set depending on the result of the accumulator AND memory value, effectively applying a bitmask and then checking if any bits are set. Bits 7 and 6 of the memory value are loaded directly into the negative and overflow flags, allowing them to be easily checked without having to load a mask into A.\n\nBecause BIT only changes CPU flags, it is sometimes used to trigger the read side effects of a hardware register without clobbering any CPU registers, or even to waste cycles as a 3-cycle NOP. As an advanced trick, it is occasionally used to hide a 1- or 2-byte instruction in its operand that is only executed if jumped to directly, allowing two code paths to be interleaved. However, because the instruction in the operand is treated as an address from which to read, this carries risk of triggering side effects if it reads a hardware register. This trick can be useful when working under tight constraints on space, time, or register usage.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "V - Overflow",
        "value": "memory bit 6",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "memory bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "zpg",
        "addressingMode": "Zero page",
        "opcode": 36,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 44,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      }
    ]
  },
  "bmi": {
    "name": "Branch if Minus",
    "operation": "PC = PC + 2 + memory (signed)",
    "description": "If the negative flag is set, BMI branches to a nearby location by adding the branch offset to the program counter. The offset is signed and has a range of [-128, 127] relative to the first byte after the branch instruction. Branching further than that requires using a JMP instruction, instead, and branching over that JMP when negative is clear with BPL.\n\nAll instructions that change A, X, or Y implicitly set or clear the negative flag based on bit 7 (the sign bit).",
    "flags": [],
    "encodings": [
      {
        "mode": "rel",
        "addressingMode": "Relative",
        "opcode": 48,
        "bytes": 2,
        "cycles": "2 (3 if branch taken, 4 if page crossed)",
        "notes": ""
      }
    ]
  },
  "bne": {
    "name": "Branch if Not Equal",
    "operation": "PC = PC + 2 + memory (signed)",
    "description": "If the zero flag is clear, BNE branches to a nearby location by adding the branch offset to the program counter. The offset is signed and has a range of [-128, 127] relative to the first byte after the branch instruction. Branching further than that requires using a JMP instruction, instead, and branching over that JMP when negative is set with BEQ.\n\nComparison uses this flag to indicate if the compared values are equal. All instructions that change A, X, or Y also implicitly set or clear the zero flag depending on whether the register becomes 0.",
    "flags": [],
    "encodings": [
      {
        "mode": "rel",
        "addressingMode": "Relative",
        "opcode": 208,
        "bytes": 2,
        "cycles": "2 (3 if branch taken, 4 if page crossed)",
        "notes": ""
      }
    ]
  },
  "bpl": {
    "name": "Branch if Plus",
    "operation": "PC = PC + 2 + memory (signed)",
    "description": "If the negative flag is clear, BPL branches to a nearby location by adding the branch offset to the program counter. The offset is signed and has a range of [-128, 127] relative to the first byte after the branch instruction. Branching further than that requires using a JMP instruction, instead, and branching over that JMP when negative is set with BMI.\n\nAll instructions that change A, X, or Y implicitly set or clear the negative flag based on bit 7 (the sign bit).",
    "flags": [],
    "encodings": [
      {
        "mode": "rel",
        "addressingMode": "Relative",
        "opcode": 16,
        "bytes": 2,
        "cycles": "2 (3 if branch taken, 4 if page crossed)",
        "notes": ""
      }
    ]
  },
  "brk": {
    "name": "Break (software IRQ)",
    "operation": "push PC + 2 high byte to stack push PC + 2 low byte to stack push NV11DIZC flags to stack PC = ($FFFE)",
    "description": "BRK triggers an interrupt request (IRQ). IRQs are normally triggered by external hardware, and BRK is the only way to do it in software. Like a typical IRQ, it pushes the current program counter and processor flags to the stack, sets the interrupt disable flag, and jumps to the IRQ handler. Unlike a typical IRQ, it sets the break flag in the flags byte that is pushed to the stack (like PHP) and it triggers an interrupt even if the interrupt disable flag is set. Notably, the return address that is pushed to the stack skips the byte after the BRK opcode. For this reason, BRK is often considered a 2-byte instruction with an unused immediate.\n\nUnfortunately, a 6502 bug allows the BRK IRQ to be overridden by an NMI occurring at the same time. In this case, only the NMI handler is called; the IRQ handler is skipped. However, the break flag is still set in the flags byte pushed to the stack, so the NMI handler can detect that this occurred (albeit slowly) by checking this flag.\n\nBecause BRK uses the value $00, any byte in a programmable ROM can be overwritten with a BRK instruction to send execution to an IRQ handler. This is useful for patching one-time programmable ROMs. BRK can also be used as a system call mechanism, and the unused byte can be used by software as an argument (although it is inconvenient to access). In the context of NES games, BRK is often most useful as a crash handler, where the unused program space is filled with $00 and the IRQ handler displays debugging information or otherwise handles the crash in a clean way.",
    "flags": [
      {
        "name": "I - Interrupt disable",
        "value": "1",
        "notes": "This is set to 1 after the old flags are pushed to the stack. The effect of changing this flag is not delayed."
      },
      {
        "name": "B - Break",
        "value": "Pushed as 1",
        "notes": "This flag exists only in the flags byte pushed to the stack, not as real state in the CPU."
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 0,
        "bytes": 1,
        "cycles": "7",
        "notes": "Although BRK only uses 1 byte, its return address skips the following byte."
      },
      {
        "mode": "imm",
        "addressingMode": "#Immediate",
        "opcode": 0,
        "bytes": 2,
        "cycles": "7",
        "notes": "Because BRK skips the following byte, it is often considered a 2-byte instruction."
      }
    ]
  },
  "bvc": {
    "name": "Branch if Overflow Clear",
    "operation": "PC = PC + 2 + memory (signed)",
    "description": "If the overflow flag is clear, BVC branches to a nearby location by adding the branch offset to the program counter. The offset is signed and has a range of [-128, 127] relative to the first byte after the branch instruction. Branching further than that requires using a JMP instruction, instead, and branching over that JMP when overflow is set with BVS.\n\nUnlike zero, negative, and even carry, overflow is modified by very few instructions. It is most often used with the BIT instruction, particularly for polling hardware registers. It is also sometimes used for signed overflow with ADC and SBC. The standard 6502 chip allows an external device to set overflow using a pin, enabling software to poll for that event, but this is not present on the NES' 2A03.",
    "flags": [],
    "encodings": [
      {
        "mode": "rel",
        "addressingMode": "Relative",
        "opcode": 80,
        "bytes": 2,
        "cycles": "2 (3 if branch taken, 4 if page crossed)",
        "notes": ""
      }
    ]
  },
  "bvs": {
    "name": "Branch if Overflow Set",
    "operation": "PC = PC + 2 + memory (signed)",
    "description": "If the overflow flag is set, BVS branches to a nearby location by adding the branch offset to the program counter. The offset is signed and has a range of [-128, 127] relative to the first byte after the branch instruction. Branching further than that requires using a JMP instruction, instead, and branching over that JMP when overflow is clear with BVC.\n\nUnlike zero, negative, and even carry, overflow is modified by very few instructions. It is most often used with the BIT instruction, particularly for polling hardware registers. It is also sometimes used for signed overflow with ADC and SBC. The standard 6502 chip allows an external device to set overflow using a pin, enabling software to poll for that event, but this is not present on the NES' 2A03 CPU.",
    "flags": [],
    "encodings": [
      {
        "mode": "rel",
        "addressingMode": "Relative",
        "opcode": 112,
        "bytes": 2,
        "cycles": "2 (3 if branch taken, 4 if page crossed)",
        "notes": ""
      }
    ]
  },
  "clc": {
    "name": "Clear Carry",
    "operation": "C = 0",
    "description": "CLC clears the carry flag. In particular, this is usually done before adding the low byte of a value with ADC to avoid adding an extra 1.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "0",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 24,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "cld": {
    "name": "Clear Decimal",
    "operation": "D = 0",
    "description": "CLD clears the decimal flag. The decimal flag normally controls whether binary-coded decimal mode (BCD) is enabled, but this mode is permanently disabled on the NES' 2A03 CPU. However, the flag itself still functions and can be used to store state.",
    "flags": [
      {
        "name": "D - Decimal",
        "value": "0",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 216,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "cli": {
    "name": "Clear Interrupt Disable",
    "operation": "I = 0",
    "description": "CLI clears the interrupt disable flag, enabling the CPU to handle hardware IRQs. The effect of changing this flag is delayed one instruction because the flag is changed after IRQ is polled, allowing the next instruction to execute before any pending IRQ is detected and serviced. This flag has no effect on NMI, which (as the \"non-maskable\" name suggests) cannot be ignored by the CPU.",
    "flags": [
      {
        "name": "I - Interrupt disable",
        "value": "0",
        "notes": "The effect of changing this flag is delayed 1 instruction."
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 88,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "clv": {
    "name": "Clear Overflow",
    "operation": "V = 0",
    "description": "CLV clears the overflow flag. There is no corresponding SEV instruction; instead, setting overflow is exposed on the 6502 CPU as a pin controlled by external hardware, and not exposed at all on the NES' 2A03 CPU.",
    "flags": [
      {
        "name": "V - Overflow",
        "value": "0",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 184,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "cmp": {
    "name": "Compare A",
    "operation": "A - memory",
    "description": "CMP compares A to a memory value, setting flags as appropriate but not modifying any registers. The comparison is implemented as a subtraction, setting carry if there is no borrow, zero if the result is 0, and negative if the result is negative. However, carry and zero are often most easily remembered as inequalities.\n\nNote that comparison does not affect overflow.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "A >= memory",
        "notes": ""
      },
      {
        "name": "Z - Zero",
        "value": "A == memory",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imm",
        "addressingMode": "#Immediate",
        "opcode": 201,
        "bytes": 2,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 197,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 213,
        "bytes": 2,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 205,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 221,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "aby",
        "addressingMode": "Absolute,Y",
        "opcode": 217,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "inx",
        "addressingMode": "(Indirect,X)",
        "opcode": 193,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "iny",
        "addressingMode": "(Indirect),Y",
        "opcode": 209,
        "bytes": 2,
        "cycles": "5 (6 if page crossed)",
        "notes": ""
      }
    ]
  },
  "cpx": {
    "name": "Compare X",
    "operation": "X - memory",
    "description": "CPX compares X to a memory value, setting flags as appropriate but not modifying any registers. The comparison is implemented as a subtraction, setting carry if there is no borrow, zero if the result is 0, and negative if the result is negative. However, carry and zero are often most easily remembered as inequalities.\n\nNote that comparison does not affect overflow.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "X >= memory",
        "notes": ""
      },
      {
        "name": "Z - Zero",
        "value": "X == memory",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imm",
        "addressingMode": "#Immediate",
        "opcode": 224,
        "bytes": 2,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 228,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 236,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      }
    ]
  },
  "cpy": {
    "name": "Compare Y",
    "operation": "Y - memory",
    "description": "CPY compares Y to a memory value, setting flags as appropriate but not modifying any registers. The comparison is implemented as a subtraction, setting carry if there is no borrow, zero if the result is 0, and negative if the result is negative. However, carry and zero are often most easily remembered as inequalities.\n\nNote that comparison does not affect overflow.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "Y >= memory",
        "notes": ""
      },
      {
        "name": "Z - Zero",
        "value": "Y == memory",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imm",
        "addressingMode": "#Immediate",
        "opcode": 192,
        "bytes": 2,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 196,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 204,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      }
    ]
  },
  "dec": {
    "name": "Decrement Memory",
    "operation": "memory = memory - 1",
    "description": "DEC subtracts 1 from a memory location. Notably, there is no version of this instruction for the accumulator; ADC or SBC must be used, instead.\n\nThis is a read-modify-write instruction, meaning that it first writes the original value back to memory before the modified value. This extra write can matter if targeting a hardware register.\n\nNote that decrement does not affect carry nor overflow.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 198,
        "bytes": 2,
        "cycles": "5",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 214,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 206,
        "bytes": 3,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 222,
        "bytes": 3,
        "cycles": "7",
        "notes": ""
      }
    ]
  },
  "dex": {
    "name": "Decrement X",
    "operation": "X = X - 1",
    "description": "DEX subtracts 1 from the X register. Note that it does not affect carry nor overflow.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 202,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "dey": {
    "name": "Decrement Y",
    "operation": "Y = Y - 1",
    "description": "DEY subtracts 1 from the Y register. Note that it does not affect carry nor overflow.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 136,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "eor": {
    "name": "Bitwise Exclusive OR",
    "operation": "A = A ^ memory",
    "description": "EOR exclusive-ORs a memory value and the accumulator, bit by bit. If the input bits are different, the resulting bit is 1. If they are the same, it is 0. This operation is also known as XOR.\n\n6502 doesn't have a bitwise NOT instruction, but using EOR with value $FF has the same behavior, inverting every bit of the other value. In fact, EOR can be thought of as NOT with a bitmask; all the 1 bits in one value have the effect of inverting the corresponding bit in the other value, while 0 bits do nothing.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imm",
        "addressingMode": "#Immediate",
        "opcode": 73,
        "bytes": 2,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 69,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 85,
        "bytes": 2,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 77,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 93,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "aby",
        "addressingMode": "Absolute,Y",
        "opcode": 89,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "inx",
        "addressingMode": "(Indirect,X)",
        "opcode": 65,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "iny",
        "addressingMode": "(Indirect),Y",
        "opcode": 81,
        "bytes": 2,
        "cycles": "5 (6 if page crossed)",
        "notes": ""
      }
    ]
  },
  "inc": {
    "name": "Increment Memory",
    "operation": "memory = memory + 1",
    "description": "INC adds 1 to a memory location. Notably, there is no version of this instruction for the accumulator; ADC or SBC must be used, instead.\n\nThis is a read-modify-write instruction, meaning that it first writes the original value back to memory before the modified value. This extra write can matter if targeting a hardware register.\n\nNote that increment does not affect carry nor overflow.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 230,
        "bytes": 2,
        "cycles": "5",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 246,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 238,
        "bytes": 3,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 254,
        "bytes": 3,
        "cycles": "7",
        "notes": ""
      }
    ]
  },
  "inx": {
    "name": "Increment X",
    "operation": "X = X + 1",
    "description": "INX adds 1 to the X register. Note that it does not affect carry nor overflow.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 232,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "iny": {
    "name": "Increment Y",
    "operation": "Y = Y + 1",
    "description": "INY adds 1 to the Y register. Note that it does not affect carry nor overflow.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 200,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "jmp": {
    "name": "Jump",
    "operation": "PC = memory",
    "description": "JMP sets the program counter to a new value, allowing code to execute from a new location. If you wish to be able to return from that location, JSR should normally be used, instead.\n\nThe indirect addressing mode uses the operand as a pointer, getting the new 2-byte program counter value from the specified address. Unfortunately, because of a CPU bug, if this 2-byte variable has an address ending in $FF and thus crosses a page, then the CPU fails to increment the page when reading the second byte and thus reads the wrong address. For example, JMP ($03FF) reads $03FF and $0300 instead of $0400. Care should be taken to ensure this variable does not cross a page.",
    "flags": [],
    "encodings": [
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 76,
        "bytes": 3,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "ind",
        "addressingMode": "(Indirect)",
        "opcode": 108,
        "bytes": 3,
        "cycles": "5",
        "notes": ""
      }
    ]
  },
  "jsr": {
    "name": "Jump to Subroutine",
    "operation": "push PC + 2 high byte to stack push PC + 2 low byte to stack PC = memory",
    "description": "JSR pushes the current program counter to the stack and then sets the program counter to a new value. This allows code to call a function and return with RTS back to the instruction after the JSR.\n\nNotably, the return address on the stack points 1 byte before the start of the next instruction, rather than directly at the instruction. This is because RTS increments the program counter before the next instruction is fetched. This differs from the return address pushed by interrupts and used by RTI, which points directly at the next instruction.",
    "flags": [],
    "encodings": [
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 32,
        "bytes": 3,
        "cycles": "6",
        "notes": ""
      }
    ]
  },
  "lda": {
    "name": "Load A",
    "operation": "A = memory",
    "description": "LDA loads a memory value into the accumulator.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imm",
        "addressingMode": "#Immediate",
        "opcode": 169,
        "bytes": 2,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 165,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 181,
        "bytes": 2,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 173,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 189,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "aby",
        "addressingMode": "Absolute,Y",
        "opcode": 185,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "inx",
        "addressingMode": "(Indirect,X)",
        "opcode": 161,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "iny",
        "addressingMode": "(Indirect),Y",
        "opcode": 177,
        "bytes": 2,
        "cycles": "5 (6 if page crossed)",
        "notes": ""
      }
    ]
  },
  "ldx": {
    "name": "Load X",
    "operation": "X = memory",
    "description": "LDX loads a memory value into the X register.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imm",
        "addressingMode": "#Immediate",
        "opcode": 162,
        "bytes": 2,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 166,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "zpy",
        "addressingMode": "Zero Page,Y",
        "opcode": 182,
        "bytes": 2,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 174,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "aby",
        "addressingMode": "Absolute,Y",
        "opcode": 190,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      }
    ]
  },
  "ldy": {
    "name": "Load Y",
    "operation": "Y = memory",
    "description": "LDY loads a memory value into the Y register.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imm",
        "addressingMode": "#Immediate",
        "opcode": 160,
        "bytes": 2,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 164,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 180,
        "bytes": 2,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 172,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 188,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      }
    ]
  },
  "lsr": {
    "name": "Logical Shift Right",
    "operation": "value = value >> 1 , or visually: 0 -> [76543210] -> C",
    "description": "LSR shifts all the bits of a memory value or the accumulator one position to the right, moving the value of each bit into the next bit. 0 is shifted into bit 7, and bit 0 is shifted into the carry flag. This is equivalent to dividing an unsigned value by 2 and rounding down, with the remainder in carry.\n\nThis is a read-modify-write instruction, meaning that its addressing modes that operate on memory first write the original value back to memory before the modified value. This extra write can matter if targeting a hardware register.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "value bit 0",
        "notes": ""
      },
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "0",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "acc",
        "addressingMode": "Accumulator",
        "opcode": 74,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 70,
        "bytes": 2,
        "cycles": "5",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 86,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 78,
        "bytes": 3,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 94,
        "bytes": 3,
        "cycles": "7",
        "notes": ""
      }
    ]
  },
  "nop": {
    "name": "No Operation",
    "operation": "",
    "description": "NOP has no effect; it merely wastes space and CPU cycles. This instruction can be useful when writing timed code to delay for a desired amount of time, as padding to ensure something does or does not cross a page, or to disable code in a binary.",
    "flags": [],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 234,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "ora": {
    "name": "Bitwise OR",
    "operation": "A = A | memory",
    "description": "ORA inclusive-ORs a memory value and the accumulator, bit by bit. If either input bit is 1, the resulting bit is 1. Otherwise, it is 0.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imm",
        "addressingMode": "#Immediate",
        "opcode": 9,
        "bytes": 2,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 5,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 21,
        "bytes": 2,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 13,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 29,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "aby",
        "addressingMode": "Absolute,Y",
        "opcode": 25,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "inx",
        "addressingMode": "(Indirect,X)",
        "opcode": 1,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "iny",
        "addressingMode": "(Indirect),Y",
        "opcode": 17,
        "bytes": 2,
        "cycles": "5 (6 if page crossed)",
        "notes": ""
      }
    ]
  },
  "pha": {
    "name": "Push A",
    "operation": "($0100 + SP) = A SP = SP - 1",
    "description": "PHA stores the value of A to the current stack position and then decrements the stack pointer.",
    "flags": [],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 72,
        "bytes": 1,
        "cycles": "3",
        "notes": ""
      }
    ]
  },
  "php": {
    "name": "Push Processor Status",
    "operation": "($0100 + SP) = NV11DIZC SP = SP - 1",
    "description": "PHP stores a byte to the stack containing the 6 status flags and B flag and then decrements the stack pointer. The B flag and extra bit are both pushed as 1. The bit order is NV1BDIZC (high to low).",
    "flags": [
      {
        "name": "B - Break",
        "value": "Pushed as 1",
        "notes": "This flag exists only in the flags byte pushed to the stack, not as real state in the CPU."
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 8,
        "bytes": 1,
        "cycles": "3",
        "notes": ""
      }
    ]
  },
  "pla": {
    "name": "Pull A",
    "operation": "SP = SP + 1 A = ($0100 + SP)",
    "description": "PLA increments the stack pointer and then loads the value at that stack position into A.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 104,
        "bytes": 1,
        "cycles": "4",
        "notes": ""
      }
    ]
  },
  "plp": {
    "name": "Pull Processor Status",
    "operation": "SP = SP + 1 NVxxDIZC = ($0100 + SP)",
    "description": "PLP increments the stack pointer and then loads the value at that stack position into the 6 status flags. The bit order is NVxxDIZC (high to low). The B flag and extra bit are ignored. Note that the effect of changing I is delayed one instruction because the flag is changed after IRQ is polled, delaying the effect until IRQ is polled in the next instruction like with CLI and SEI.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "result bit 0",
        "notes": ""
      },
      {
        "name": "Z - Zero",
        "value": "result bit 1",
        "notes": ""
      },
      {
        "name": "I - Interrupt disable",
        "value": "result bit 2",
        "notes": "The effect of changing this flag is delayed 1 instruction."
      },
      {
        "name": "D - Decimal",
        "value": "result bit 3",
        "notes": ""
      },
      {
        "name": "V - Overflow",
        "value": "result bit 6",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 40,
        "bytes": 1,
        "cycles": "4",
        "notes": ""
      }
    ]
  },
  "rol": {
    "name": "Rotate Left",
    "operation": "value = value << 1 through C , or visually: C <- [76543210] <- C",
    "description": "ROL shifts a memory value or the accumulator to the left, moving the value of each bit into the next bit and treating the carry flag as though it is both above bit 7 and below bit 0. Specifically, the value in carry is shifted into bit 0, and bit 7 is shifted into carry. Rotating left 9 times simply returns the value and carry back to their original state.\n\nThis is a read-modify-write instruction, meaning that its addressing modes that operate on memory first write the original value back to memory before the modified value. This extra write can matter if targeting a hardware register.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "value bit 7",
        "notes": ""
      },
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "acc",
        "addressingMode": "Accumulator",
        "opcode": 42,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 38,
        "bytes": 2,
        "cycles": "5",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 54,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 46,
        "bytes": 3,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 62,
        "bytes": 3,
        "cycles": "7",
        "notes": ""
      }
    ]
  },
  "ror": {
    "name": "Rotate Right",
    "operation": "value = value >> 1 through C , or visually: C -> [76543210] -> C",
    "description": "ROR shifts a memory value or the accumulator to the right, moving the value of each bit into the next bit and treating the carry flag as though it is both above bit 7 and below bit 0. Specifically, the value in carry is shifted into bit 7, and bit 0 is shifted into carry. Rotating right 9 times simply returns the value and carry back to their original state.\n\nThis is a read-modify-write instruction, meaning that its addressing modes that operate on memory first write the original value back to memory before the modified value. This extra write can matter if targeting a hardware register.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "value bit 0",
        "notes": ""
      },
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "acc",
        "addressingMode": "Accumulator",
        "opcode": 106,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 102,
        "bytes": 2,
        "cycles": "5",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 118,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 110,
        "bytes": 3,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 126,
        "bytes": 3,
        "cycles": "7",
        "notes": ""
      }
    ]
  },
  "rti": {
    "name": "Return from Interrupt",
    "operation": "pull NVxxDIZC flags from stack pull PC low byte from stack pull PC high byte from stack",
    "description": "RTI returns from an interrupt handler, first pulling the 6 status flags from the stack and then pulling the new program counter. The flag pulling behaves like PLP except that changes to the interrupt disable flag apply immediately instead of being delayed 1 instruction. This is because the flags change before IRQs are polled for the instruction, not after. The PC pulling behaves like RTS except that the return address is the exact address of the next instruction instead of 1 byte before it.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "pulled flags bit 0",
        "notes": ""
      },
      {
        "name": "Z - Zero",
        "value": "pulled flags bit 1",
        "notes": ""
      },
      {
        "name": "I - Interrupt disable",
        "value": "pulled flags bit 2",
        "notes": "The effect of changing this flag is not delayed."
      },
      {
        "name": "D - Decimal",
        "value": "pulled flags bit 3",
        "notes": ""
      },
      {
        "name": "V - Overflow",
        "value": "pulled flags bit 6",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "pulled flags bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 64,
        "bytes": 1,
        "cycles": "6",
        "notes": ""
      }
    ]
  },
  "rts": {
    "name": "Return from Subroutine",
    "operation": "pull PC low byte from stack pull PC high byte from stack PC = PC + 1",
    "description": "RTS pulls an address from the stack into the program counter and then increments the program counter. It is normally used at the end of a function to return to the instruction after the JSR that called the function. However, RTS is also sometimes used to implement jump tables (see Jump table and RTS Trick).",
    "flags": [],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 96,
        "bytes": 1,
        "cycles": "6",
        "notes": ""
      }
    ]
  },
  "sbc": {
    "name": "Subtract with Carry",
    "operation": "A = A - memory - ~C , or equivalently: A = A + ~memory + C",
    "description": "SBC subtracts a memory value and the NOT of the carry flag from the accumulator. It does this by adding the bitwise NOT of the memory value using ADC. This implementation detail explains the backward nature of carry; SBC subtracts 1 more when carry is clear, not when it's set, and carry is cleared when it underflows and set otherwise. As with ADC, carry allows the borrow from one subtraction to be carried into the next subtraction, allowing subtraction of values larger than 1 byte. It is common to set carry with SEC before subtracting the first byte to ensure it is in a known state, avoiding an off-by-one error.\n\nOverflow works the same as with ADC, except with an inverted memory value. Therefore, overflow or underflow occur if the result's sign is different from A's and the same as the memory value's.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "~(result < $00)",
        "notes": "If the result underflowed below $00 (wrapping around), unsigned underflow occurred."
      },
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "V - Overflow",
        "value": "(result ^ A) & (result ^ ~memory) & $80",
        "notes": "If result's sign is different from A's and the same as memory's, signed overflow (or underflow) occurred."
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imm",
        "addressingMode": "#Immediate",
        "opcode": 233,
        "bytes": 2,
        "cycles": "2",
        "notes": ""
      },
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 229,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 245,
        "bytes": 2,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 237,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 253,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "aby",
        "addressingMode": "Absolute,Y",
        "opcode": 249,
        "bytes": 3,
        "cycles": "4 (5 if page crossed)",
        "notes": ""
      },
      {
        "mode": "inx",
        "addressingMode": "(Indirect,X)",
        "opcode": 225,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "iny",
        "addressingMode": "(Indirect),Y",
        "opcode": 241,
        "bytes": 2,
        "cycles": "5 (6 if page crossed)",
        "notes": ""
      }
    ]
  },
  "sec": {
    "name": "Set Carry",
    "operation": "C = 1",
    "description": "SEC sets the carry flag. In particular, this is usually done before subtracting the low byte of a value with SBC to avoid subtracting an extra 1.",
    "flags": [
      {
        "name": "C - Carry",
        "value": "1",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 56,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "sed": {
    "name": "Set Decimal",
    "operation": "D = 1",
    "description": "SED sets the decimal flag. The decimal flag normally controls whether binary-coded decimal mode (BCD) is enabled, but this mode is permanently disabled on the NES' 2A03 CPU. However, the flag itself still functions and can be used to store state.",
    "flags": [
      {
        "name": "D - Decimal",
        "value": "1",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 248,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "sei": {
    "name": "Set Interrupt Disable",
    "operation": "I = 1",
    "description": "SEI sets the interrupt disable flag, preventing the CPU from handling hardware IRQs. The effect of changing this flag is delayed one instruction because the flag is changed after IRQ is polled, allowing an IRQ to be serviced between this and the next instruction if the flag was previously 0.",
    "flags": [
      {
        "name": "I - Interrupt disable",
        "value": "1",
        "notes": "The effect of changing this flag is delayed 1 instruction."
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 120,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "sta": {
    "name": "Store A",
    "operation": "memory = A",
    "description": "STA stores the accumulator value into memory.",
    "flags": [],
    "encodings": [
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 133,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 149,
        "bytes": 2,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 141,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abx",
        "addressingMode": "Absolute,X",
        "opcode": 157,
        "bytes": 3,
        "cycles": "5",
        "notes": ""
      },
      {
        "mode": "aby",
        "addressingMode": "Absolute,Y",
        "opcode": 153,
        "bytes": 3,
        "cycles": "5",
        "notes": ""
      },
      {
        "mode": "inx",
        "addressingMode": "(Indirect,X)",
        "opcode": 129,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      },
      {
        "mode": "iny",
        "addressingMode": "(Indirect),Y",
        "opcode": 145,
        "bytes": 2,
        "cycles": "6",
        "notes": ""
      }
    ]
  },
  "stx": {
    "name": "Store X",
    "operation": "memory = X",
    "description": "STX stores the X register value into memory.",
    "flags": [],
    "encodings": [
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 134,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "zpy",
        "addressingMode": "Zero Page,Y",
        "opcode": 150,
        "bytes": 2,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 142,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      }
    ]
  },
  "sty": {
    "name": "Store Y",
    "operation": "memory = Y",
    "description": "STY stores the Y register value into memory.",
    "flags": [],
    "encodings": [
      {
        "mode": "zpg",
        "addressingMode": "Zero Page",
        "opcode": 132,
        "bytes": 2,
        "cycles": "3",
        "notes": ""
      },
      {
        "mode": "zpx",
        "addressingMode": "Zero Page,X",
        "opcode": 148,
        "bytes": 2,
        "cycles": "4",
        "notes": ""
      },
      {
        "mode": "abs",
        "addressingMode": "Absolute",
        "opcode": 140,
        "bytes": 3,
        "cycles": "4",
        "notes": ""
      }
    ]
  },
  "tax": {
    "name": "Transfer A to X",
    "operation": "X = A",
    "description": "TAX copies the accumulator value to the X register.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 170,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "tay": {
    "name": "Transfer A to Y",
    "operation": "Y = A",
    "description": "TAY copies the accumulator value to the Y register.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 168,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "tsx": {
    "name": "Transfer Stack Pointer to X",
    "operation": "X = SP",
    "description": "TSX copies the stack pointer value to the X register.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 186,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "txa": {
    "name": "Transfer X to A",
    "operation": "A = X",
    "description": "TXA copies the X register value to the accumulator.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 138,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "txs": {
    "name": "Transfer X to Stack Pointer",
    "operation": "SP = X",
    "description": "TXS copies the X register value to the stack pointer.",
    "flags": [],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 154,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  },
  "tya": {
    "name": "Transfer Y to A",
    "operation": "A = Y",
    "description": "TYA copies the Y register value to the accumulator.",
    "flags": [
      {
        "name": "Z - Zero",
        "value": "result == 0",
        "notes": ""
      },
      {
        "name": "N - Negative",
        "value": "result bit 7",
        "notes": ""
      }
    ],
    "encodings": [
      {
        "mode": "imp",
        "addressingMode": "Implied",
        "opcode": 152,
        "bytes": 1,
        "cycles": "2",
        "notes": ""
      }
    ]
  }
};
