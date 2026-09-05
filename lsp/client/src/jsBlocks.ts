// SPDX-License-Identifier: MPL-2.0

/**
 * Makes the JavaScript in `.jsbegin` blocks legible to the editor's JS tooling.
 *
 * Creates a temp .js file with the predefined `a` and `defines` and all
 * the included modules and globals so that the regular javascript LSP can
 * handle this itself.
 */

import {createHash} from 'node:crypto';
import * as vscode from 'vscode';

import type {JsGlobals} from './jsGlobals';

const GLOB_META = /[*?]/;

const RE_JSBEGIN = /^\s*\.jsbegin\b/i;
const RE_JSEND = /^\s*\.jsend\b/i;
// `.jsinput <name>, "<path>"`, matching the preprocessor's own parse.
const RE_JSINPUT = /^\s*\.jsinput\s+([A-Za-z_$][\w$]*)\s*,\s*(?:"([^"]*)"|'([^']*)')/i;

/** A `.jsbegin`/`.jsend` body, as 0-based end-exclusive lines. */
export interface JsBlock {
  startLine: number;
  endLine: number;
}

export interface JsInputBinding {
  name: string;
  pattern: string;
  isGlob: boolean;
}

export interface JsBlockScan {
  blocks: JsBlock[];
  inputs: JsInputBinding[];
}

/** Finds the blocks and `.jsinput` bindings in a document. */
export function scanJsBlocks(text: string): JsBlockScan {
  const lines = text.split(/\r?\n/);
  const blocks: JsBlock[] = [];
  const inputs: JsInputBinding[] = [];
  const seen = new Set<string>();
  let start: number | undefined;

  for (let i = 0; i < lines.length; i++) {
    if (start === undefined) {
      if (RE_JSBEGIN.test(lines[i])) { start = i + 1; continue; }
      const m = RE_JSINPUT.exec(lines[i]);
      if (m) {
        const name = m[1];
        const pattern = m[2] ?? m[3];
        // A repeated name is the same binding, and declaring it twice is an error.
        if (!seen.has(name)) {
          seen.add(name);
          inputs.push({name, pattern, isGlob: GLOB_META.test(pattern)});
        }
      }
      continue;
    }
    if (RE_JSEND.test(lines[i])) {
      blocks.push({startLine: start, endLine: i});
      start = undefined;
    }
  }
  // An unterminated block still runs to the end of the file for editing purposes.
  if (start !== undefined) blocks.push({startLine: start, endLine: lines.length});
  return {blocks, inputs};
}

/** The `.jsinput` half of the ambient declarations, which varies per file. */
export function renderInputDeclarations(inputs: readonly JsInputBinding[]): string {
  return inputs.map(({name, pattern, isGlob}) => {
    const type = isGlob ? 'JsInputFile[]' : 'JsInputFile';
    return `/** \`.jsinput ${name}, "${pattern}"\` */\ndeclare const ${name}: ${type};`;
  }).join('\n\n');
}

export function blockAt(blocks: readonly JsBlock[], line: number): JsBlock | undefined {
  return blocks.find(b => line >= b.startLine && line < b.endLine);
}

/** Renders a document as a standalone JavaScript file for the JS language server */
export function renderJsMirror(text: string, blocks: readonly JsBlock[]): string {
  const lines = text.split(/\r?\n/);
  const out = lines.map(() => '');
  for (const b of blocks) {
    for (let i = b.startLine; i < b.endLine && i < lines.length; i++) out[i] = lines[i];
  }
  return `${out.join('\n')}\nexport {};\n`;
}

/** Where the mirrors and the declarations they see live, under extension storage. */
export const MIRROR_DIR = 'jsblocks';

/**
 * The project the mirrors belong to. We need this configuration file
 * so that the js lsp handles the type definitions properly.
 */
const JSCONFIG = JSON.stringify({
  compilerOptions: {
    allowJs: true,
    checkJs: false,
    noEmit: true,
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'Bundler',
    lib: ['ES2022'],
    types: [],
  },
  include: ['*.js', '*.d.ts'],
}, null, 2);

// How many items to return in the resolve list for JS completion
const RESOLVE_COUNT = 25;

const TRIGGERS = ['.', '"', '\'', '`', '/', '@', '<', '#'];

// What opens and updates a signature popup, again matching the JS service.
const SIGNATURE_TRIGGERS = {triggerCharacters: ['(', ',', '<'],
                            retriggerCharacters: [')']};

export function registerJsBlockCompletion(
    context: vscode.ExtensionContext, globals: JsGlobals): void {
  const storage = context.storageUri ?? context.globalStorageUri;
  if (!storage) return;
  const mirrors = new Mirrors(vscode.Uri.joinPath(storage, MIRROR_DIR));

  /** The mirror to ask about `position`, or nothing if it is not in a block. */
  const mirrorFor = async (doc: vscode.TextDocument, position: vscode.Position,
                           token: vscode.CancellationToken) => {
    const blocks = scanJsBlocks(doc.getText()).blocks;
    if (!blockAt(blocks, position.line)) return undefined;
    // The `.jsinput` declarations are part of what a block can name, and they
    // change as the user edits the file.
    await globals.refresh();
    const mirror = await mirrors.write(doc, blocks);
    return token.isCancellationRequested ? undefined : mirror;
  };

  // Building a mirror is what creates its project, and while a project loads
  // VS Code answers from a syntax-only server that cannot see the declarations.
  // Doing it when the document opens spends that wait before anyone is typing.
  const warm = async (doc: vscode.TextDocument) => {
    if (doc.languageId !== 'js65') return;
    const blocks = scanJsBlocks(doc.getText()).blocks;
    if (!blocks.length) return;
    await globals.refresh();
    await mirrors.write(doc, blocks);
  };
  for (const doc of vscode.workspace.textDocuments) void discard(warm(doc));

  context.subscriptions.push(
    mirrors,
    vscode.workspace.onDidOpenTextDocument(doc => void discard(warm(doc))),
    vscode.workspace.onDidCloseTextDocument(doc => mirrors.drop(doc.uri)),
    vscode.languages.registerCompletionItemProvider(
      {language: 'js65'},
      {
        async provideCompletionItems(doc, position, token, ctx) {
          const mirror = await mirrorFor(doc, position, token);
          if (!mirror) return undefined;
          return await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            mirror, position, ctx.triggerCharacter, RESOLVE_COUNT);
        },
      },
      ...TRIGGERS),
    vscode.languages.registerSignatureHelpProvider(
      {language: 'js65'},
      {
        async provideSignatureHelp(doc, position, token, ctx) {
          const mirror = await mirrorFor(doc, position, token);
          if (!mirror) return undefined;
          return await vscode.commands.executeCommand<vscode.SignatureHelp>(
            'vscode.executeSignatureHelpProvider',
            mirror, position, ctx.triggerCharacter);
        },
      },
      SIGNATURE_TRIGGERS),
    vscode.languages.registerHoverProvider(
      {language: 'js65'},
      {
        async provideHover(doc, position, token) {
          const mirror = await mirrorFor(doc, position, token);
          if (!mirror) return undefined;
          const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider', mirror, position);
          // The command returns one hover per provider; a single provider has
          // to fold them back into one.
          const contents = hovers?.flatMap(h => h.contents) ?? [];
          return contents.length
            ? new vscode.Hover(contents, hovers.find(h => h.range)?.range)
            : undefined;
        },
      }),
  );
}

class Mirrors implements vscode.Disposable {
  private readonly paths = new Map<string, vscode.Uri>();
  private project: Promise<void> | undefined;

  constructor(private readonly dir: vscode.Uri) {}

  async write(doc: vscode.TextDocument, blocks: readonly JsBlock[]):
    Promise<vscode.Uri | undefined> {
    const text = renderJsMirror(doc.getText(), blocks);
    const key = doc.uri.toString();
    let uri = this.paths.get(key);
    try {
      if (!uri) {
        await (this.project ??= this.createProject());
        uri = vscode.Uri.joinPath(
          this.dir, `${createHash('sha1').update(key).digest('hex').slice(0, 16)}.js`);
        await vscode.workspace.fs.writeFile(uri, Buffer.from(text, 'utf8'));
        this.paths.set(key, uri);
      }
      const mirror = await vscode.workspace.openTextDocument(uri);
      // The model can be behind the file just written, or ahead of it from an
      // earlier keystroke. Editing it is the only update the language service
      // is guaranteed to have seen by the time the next request goes out.
      if (mirror.getText() !== text) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(uri, new vscode.Range(0, 0, mirror.lineCount, 0), text);
        if (!await vscode.workspace.applyEdit(edit)) return undefined;
        await mirror.save();
      }
      return uri;
    } catch {
      return undefined;
    }
  }

  drop(docUri: vscode.Uri): void {
    const mirror = this.paths.get(docUri.toString());
    if (!mirror) return;
    this.paths.delete(docUri.toString());
    void discard(vscode.workspace.fs.delete(mirror));
  }

  dispose(): void {
    this.paths.clear();
    void discard(vscode.workspace.fs.delete(this.dir, {recursive: true}));
  }

  private async createProject(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.dir);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.dir, 'jsconfig.json'), Buffer.from(JSCONFIG, 'utf8'));
  }
}

/** Housekeeping on scratch files is not worth surfacing to the user. */
function discard(op: Thenable<unknown>): Thenable<unknown> {
  return op.then(undefined, () => undefined);
}
