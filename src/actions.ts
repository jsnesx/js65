// SPDX-License-Identifier: MPL-2.0

import type { Assembler } from './assembler.ts';
import type { SourceInfo } from './error.ts';
import * as Exprs from './expr.ts';
import type { Expr } from './expr.ts';
import type { ActionSource, AssemblyAction } from './libassembler.ts';
import { MaxKeySizeCacheMap } from './util.ts';

/** Callback to run a `code` action's source through the full tokenize/preprocess pipeline. */
export type CodeRunner = (asm: Assembler, code: string, name?: string) => void;

export function toSourceInfo(source?: ActionSource): SourceInfo | undefined {
  if (!source) return undefined;
  return { file: source.file, line: source.line, column: 0 };
}

function toValueExpr(v: number | { op: 'sym', sym: string }): Expr {
  return typeof v === 'number' ? { op: 'num', num: v } : v;
}

/** Replays an action list onto a live assembler, in order. */
export function runActions(asm: Assembler, actions: readonly AssemblyAction[],
                           runCode?: CodeRunner): void {
  for (const action of actions) {
    asm.setSource(toSourceInfo(action.source));

    switch (action.action) {
      case 'code':
        if (!runCode) {
          asm.fail(`code actions are not supported here`);
        }
        runCode(asm, action.code, action.name);
        break;

      case 'label':
        asm.label(action.label);
        break;

      case 'byte':
        asm.byte(...action.bytes);
        break;

      case 'word':
        asm.word(...action.words);
        break;

      case 'hibytes':
        asm.byte(...action.values.map(v => Exprs.hiByte(toValueExpr(v))));
        break;

      case 'lobytes':
        asm.byte(...action.values.map(v => Exprs.loByte(toValueExpr(v))));
        break;

      case 'literal':
        asm.byteInternal(action.values, new MaxKeySizeCacheMap());
        break;

      case 'org':
        asm.org(action.addr, action.name);
        break;

      case 'segment':
        asm.segment(...(Array.isArray(action.name) ? action.name : [action.name]));
        break;

      case 'reloc':
        asm.reloc(action.name);
        break;

      case 'export':
        asm.export(action.name);
        break;

      case 'exportzp':
        asm.exportzp(...action.names);
        break;

      case 'import':
        asm.import(...action.names);
        break;

      case 'importzp':
        asm.importzp(...action.names);
        break;

      case 'global':
        asm.global(...action.names);
        break;

      case 'globalzp':
        asm.globalzp(...action.names);
        break;

      case 'align':
        asm.align(action.boundary, action.fill);
        break;

      case 'res':
        asm.res(action.count, action.value);
        break;

      case 'charmap':
        asm.charMap(action.code, action.target);
        break;

      case 'strmap':
        asm.strMap(action.key, action.bytes);
        break;

      case 'pushcharmap':
        asm.pushCharmap();
        break;

      case 'popcharmap':
        asm.popCharmap();
        break;

      case 'assign': {
        const value = typeof action.value === 'string'
            ? parseInt(action.value, 10)
            : action.value;
        asm.assign(action.name, value);
        break;
      }

      case 'set': {
        const value = typeof action.value === 'string'
            ? parseInt(action.value, 10)
            : action.value;
        asm.set(action.name, value);
        break;
      }

      case 'free':
        asm.free(action.size);
        break;

      default:
        console.warn(`Unknown action type:`, action);
    }
  }
}
