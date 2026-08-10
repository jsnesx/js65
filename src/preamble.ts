
// SPDX-License-Identifier: MPL-2.0

// If the user doesn't provide any segment or header information
// this provides a barebones NES compile target

import { Segment } from "./module.ts";

export interface Target {
  segments: Segment[];
}

export const Sim: Target = {
  segments: [{
    name: 'ZEROPAGE',
    addressing: 1,
    size: 0x100,
    memory: 0x00,
  }, {
    name: 'CODE',
    default: true,
    offset: 0x00,
    size: 0xfd00,
    memory: 0x200,
    free: [[0x0200, 0xfd00]],
  }, {
    name: 'RODATA',
    offset: 0x00,
    size: 0xfd00,
    memory: 0x200,
  }, {
    name: 'DATA',
    offset: 0x00,
    size: 0xfd00,
    memory: 0x200,
  }],
}

export const NesNrom: Target = {
  segments: [{
    name: 'ZEROPAGE',
    addressing: 1,
    size: 0x100,
    memory: 0x00,
  }, {
    // $0100-$01ff is the hardware stack, so BSS starts after it.
    name: 'BSS',
    size: 0x600,
    memory: 0x200,
  }, {
    name: 'HEADER',
    size: 0x10,
    offset: 0x00,
    memory: 0x00,
  }, {
    name: 'CODE',
    default: true,
    size: 0x8000,
    offset: 0x00010,
    memory: 0x8000,
    fill: 0x00,
    free: [[0x8000, 0x10000]],
  }, {
    name: 'RODATA',
    size: 0x8000,
    offset: 0x00010,
    memory: 0x8000,
  }, {
    name: 'DATA',
    size: 0x8000,
    offset: 0x00010,
    memory: 0x8000,
  }, {
    name: 'CHR',
    size: 0x2000,
    offset: 0x08010,
    memory: 0x00,
  }]
}

export const Targets: Map<string|undefined, Target> = new Map([
  ['sim', Sim],
  ['nes-nrom', NesNrom],
]);
