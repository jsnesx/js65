import type * as Monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import {Cpu} from '../../src/cpu.ts';

export function registerLanguage(monaco: typeof Monaco): Monaco.IDisposable {
  monaco.languages.register({id: 'js65', extensions: ['.s', '.asm', '.inc']});
  return monaco.languages.setMonarchTokensProvider('js65', {
    ignoreCase: true,
    mnemonics: Object.keys(Cpu.P02.table),
    tokenizer: {
      root: [
        [/;.*$/, 'comment'],
        [/\.js(post)?begin\b/, {token: 'keyword', next: '@javascript'}],
        [/\.[a-z_][\w]*/, 'keyword'],
        [/[a-z_@][\w@]*(?=\s*:)/, 'type.identifier'],
        [/"([^"\\]|\\.)*"/, 'string'],
        [/\$[\da-f]+|%[01]+|\b\d+\b/, 'number'],
        [/[a-z_@][\w@]*/, {cases: {'@mnemonics': 'keyword', '@default': 'identifier'}}],
      ],
      javascript: [
        [/\.js(post)?end\b/, {token: 'keyword', next: '@pop'}],
        [/\/\/.*$/, 'comment'],
        [/"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/, 'string'],
        [/\b(const|let|var|function|return|if|else|for|while)\b/, 'keyword'],
        [/\b\d+\b/, 'number'],
        [/./, 'source'],
      ],
    },
  });
}
