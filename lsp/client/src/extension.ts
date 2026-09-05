// SPDX-License-Identifier: MPL-2.0

/**
 * VS Code client for the js65 language server.
 */

import * as vscode from 'vscode';
import {
	DocumentFilter,
	LanguageClient,
	LanguageClientOptions,
	RevealOutputChannelOn,
	State,
} from 'vscode-languageclient/node';

import { registerMacroExpansion } from './expandMacro';
import { registerInactiveRegions, type RebindInactiveRegions } from './inactiveRegions';
import { registerJsBlockCompletion } from './jsBlocks';
import { registerJsGlobals } from './jsGlobals';
import { registerJsModuleSource } from './jsModuleSource';
import { resolveServerModule, serverOptionsFor } from './server';

let client: LanguageClient | undefined;
let outputChannel: vscode.LogOutputChannel | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let rebindInactiveRegions: RebindInactiveRegions | undefined;

export interface Js65Api {
	getClient(): LanguageClient | undefined;
}

export async function activate(context: vscode.ExtensionContext): Promise<Js65Api> {
	outputChannel = vscode.window.createOutputChannel('js65 Language Server', {log: true});
	statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
	statusItem.command = 'js65.showOutput';
	context.subscriptions.push(outputChannel, statusItem);

	context.subscriptions.push(
		vscode.commands.registerCommand('js65.restartServer', () => restart(context)),
		vscode.commands.registerCommand('js65.showOutput', () => outputChannel?.show(true)),
	);
	registerMacroExpansion(context, () => client);
	registerJsModuleSource(context, () => client);
	rebindInactiveRegions = registerInactiveRegions(context);
	const jsGlobals = registerJsGlobals(context, outputChannel);
	if (jsGlobals) registerJsBlockCompletion(context, jsGlobals);

	// A change to how the server is launched only takes effect on restart, so do
	// it for the user rather than making them find the command.
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(async (e) => {
			if (e.affectsConfiguration('js65.server')) await restart(context);
		}),
		vscode.workspace.onDidChangeWorkspaceFolders(() => restart(context)),
	);

	await start(context);
	return {getClient: () => client};
}

export async function deactivate(): Promise<void> {
	await stop();
}

/** Start the client, unless disabled or no server module can be found. */
async function start(context: vscode.ExtensionContext): Promise<void> {
	if (!vscode.workspace.getConfiguration('js65').get<boolean>('server.enable', true)) {
		setStatus('$(circle-slash) js65', 'Language server disabled by js65.server.enable');
		return;
	}

	const resolved = resolveServerModule(context);
	if (!resolved) {
		setStatus('$(error) js65', 'No language server found. See the js65 output channel');
		const configured = vscode.workspace.getConfiguration('js65').get<string | null>('server.path');
		outputChannel?.appendLine(configured
			? `Could not find a server at js65.server.path: ${configured}`
			: 'No bundled server found. Run `bun run build:server` in the extension, ' +
			  'or point js65.server.path at a js65-lsp.cjs built with `bun run lsp`.');
		void vscode.window.showErrorMessage(
			'js65: language server not found.',
			'Show Output',
		).then(pick => { if (pick) outputChannel?.show(true); });
		return;
	}
	outputChannel?.appendLine(`Starting js65 language server (${resolved.origin}): ${resolved.module}`);

	// Scope the client to this window's own folders instead of the first opened window
	const folders = vscode.workspace.workspaceFolders ?? [];
	const documentSelector: DocumentFilter[] = folders.length
		? folders.map(folder => ({
			scheme: 'file',
			language: 'js65',
			pattern: `${folder.uri.fsPath.replace(/\\/g, '/')}/**/*`,
		}))
		: [{ scheme: 'file', language: 'js65' }];
	const clientOptions: LanguageClientOptions = {
		documentSelector,
		workspaceFolder: folders[0],
		outputChannel,
		revealOutputChannelOn: RevealOutputChannelOn.Never,
		initializationOptions: {},
	};

	client = new LanguageClient('js65', 'js65 Language Server', serverOptionsFor(resolved.module), clientOptions);

	// Track connection state in the status bar. A server that died silently is
	// otherwise indistinguishable from a file with no errors in it.
	context.subscriptions.push(client.onDidChangeState(e => {
		switch (e.newState) {
			case State.Running:
				setStatus('$(check) js65', 'js65 language server is running');
				break;
			case State.Starting:
				setStatus('$(sync~spin) js65', 'js65 language server is starting');
				break;
			case State.Stopped:
				setStatus('$(warning) js65', 'js65 language server stopped. Click for output');
				break;
		}
	}));

	try {
		await client.start();
		// Only after `start()` resolves: notifications arriving on a client that
		// has no handler yet are dropped, not queued.
		rebindInactiveRegions?.(client);
	} catch (err) {
		outputChannel?.appendLine(`Failed to start: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
		setStatus('$(error) js65', 'js65 language server failed to start. Click for output');
		void vscode.window.showErrorMessage(
			`js65: language server failed to start: ${err instanceof Error ? err.message : String(err)}`);
		client = undefined;
	}
}

/** Stop the running client, tolerating one that never started. */
async function stop(): Promise<void> {
	const running = client;
	client = undefined;
	if (!running) return;
	try {
		await running.stop();
	} catch (err) {
		// A server that already exited rejects `stop()`; that's not worth
		// surfacing to the user, but it belongs in the log.
		outputChannel?.appendLine(`Error stopping server: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function restart(context: vscode.ExtensionContext): Promise<void> {
	outputChannel?.appendLine('Restarting js65 language server...');
	await stop();
	await start(context);
}

function setStatus(text: string, tooltip: string): void {
	if (!statusItem) return;
	statusItem.text = text;
	statusItem.tooltip = tooltip;
	statusItem.show();
}

/** Exposed for the end-to-end tests, which wait for the client to be ready. */
export function getClient(): LanguageClient | undefined {
	return client;
}
