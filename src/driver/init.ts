
// SPDX-License-Identifier: MPL-2.0

import { Targets } from '../preamble.ts';
import { joinDir } from '../util.ts';
import { parseEntry, type Callbacks } from './fs.ts';

export const DEFAULT_TARGET = 'nes-nrom';

/** The project name used when `js65 init` is run without one, in the current directory. */
const DEFAULT_NAME = 'main';

export interface InitOptions {
  /** Directory to scaffold into. Empty or `.` means the current directory. */
  dir?: string;
  /** Project name, and the stem of its output. Defaults to `dir`'s last segment. */
  name?: string;
  /** Built-in segment layout the generated project links with. */
  target?: string;
  /** Scaffold into a directory that already holds files, overwriting what collides. */
  force?: boolean;
}

export interface InitResult {
  /** Directory that was written into, as given. */
  dir: string;
  name: string;
  /** Every file written, relative to `dir`, in the order they were written. */
  files: string[];
}

/** One file of the scaffold. Binary assets carry `bytes`; the rest are text. */
interface Template {
  path: string;
  text: string;
  bytes?: Uint8Array;
}

export function scaffold(name: string, target = DEFAULT_TARGET): Template[] {
  return [
    {path: 'js65.json', text: projectFile(name, target)},
    {path: 'src/main.s', text: MAIN_SOURCE},
    {path: 'inc/constants.inc', text: CONSTANTS},
    {path: 'assets/tiles.chr', text: '', bytes: new Uint8Array(8192)},
  ];
}

function projectFile(name: string, target: string): string {
  const config = {
    projects: [{
      name,
      // A glob rather than a list, so a new file under src/ is picked up by the next
      // build. Headers are `.inc`, which keeps this pattern from assembling one as a
      // module of its own and colliding with the file that includes it.
      sources: ['src/**/*.s'],
      includePaths: ['inc'],
      binIncludePaths: ['assets'],
      target,
    }],
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Write the initial project code, but chickens out if any non .folders/.files exist 
 */
export async function init(cb: Callbacks, options: InitOptions = {}): Promise<InitResult> {
  const dir = options.dir && options.dir !== '.' ? options.dir : '';
  const name = options.name || baseOf(dir) || DEFAULT_NAME;
  const target = options.target ?? DEFAULT_TARGET;
  if (!Targets.has(target)) {
    const known = [...Targets.keys()].filter(t => t).join(', ');
    throw new Error(`unknown target "${target}" (js65 has ${known})`);
  }
  if (!options.force) await checkEmpty(cb, dir);

  const files: string[] = [];
  for (const file of scaffold(name, target)) {
    // Hosts create missing parent directories on write, so `src/` and friends need no
    // separate mkdir step.
    if (file.bytes !== undefined) {
      await cb.fsWriteBytes('', joinDir(dir, file.path), file.bytes);
    } else {
      await cb.fsWriteString('', joinDir(dir, file.path), file.text);
    }
    files.push(file.path);
  }
  return {dir: options.dir ?? '', name, files};
}

async function checkEmpty(cb: Callbacks, dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await cb.fsListDir(dir || '.');
  } catch {
    // fsListDir rejects when the directory is absent, which is the normal case for
    // `js65 init demo`. The first write creates it.
    return;
  }
  const used = entries.map(e => parseEntry(e).name).filter(n => !n.startsWith('.')).sort();
  if (used.length) {
    throw new Error(
        `${dir || '.'} is not empty (found ${used.slice(0, 3).join(', ')}` +
        `${used.length > 3 ? ', ...' : ''}). Use --force to scaffold anyway.`);
  }
}

function baseOf(p: string): string {
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

const MAIN_SOURCE = `\
.include "constants.inc"

.segment "HEADER"
  .byte "NES", $1a
  .byte 2               ; 32KB of PRG ROM, as two 16KB banks
  .byte 1               ; 8KB of CHR ROM
  .byte $01             ; mapper 0 (NROM), vertical mirroring
  .res 9, $00

.zeropage
frame_count: .res 1

.code

reset:
  sei
  cld
  ldx #$40
  stx APU_FRAME
  ldx #$ff
  txs
  inx
  stx PPU_CTRL
  stx PPU_MASK
  stx frame_count

  bit PPU_STATUS
- bit PPU_STATUS
  bpl -
- bit PPU_STATUS
  bpl -

  lda #%10000000
  sta PPU_CTRL
forever:
  jmp forever

nmi:
  inc frame_count
  rti

irq:
  rti

.org $fffa
  .word nmi
  .word reset
  .word irq

.segment "CHR"
.incbin "tiles.chr"
`;

const CONSTANTS = `\
PPU_CTRL    = $2000
PPU_MASK    = $2001
PPU_STATUS  = $2002
OAM_ADDR    = $2003
OAM_DATA    = $2004
PPU_SCROLL  = $2005
PPU_ADDR    = $2006
PPU_DATA    = $2007

APU_DMC_CTRL = $4010
OAM_DMA      = $4014
APU_STATUS   = $4015
JOY1         = $4016
JOY2         = $4017
APU_FRAME    = $4017
`;
