// SPDX-License-Identifier: MPL-2.0

/**
 * Locating and launching the js65 language server.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ExtensionContext, workspace } from 'vscode';
import { ServerOptions, TransportKind } from 'vscode-languageclient/node';

/** Filename of the bundled server, in both the repo build dir and here. */
export const SERVER_BUNDLE = 'js65-lsp.cjs';

/** Where a server module came from surfaced in the output channel. */
export interface ResolvedServer {
	readonly module: string;
	readonly origin: 'setting' | 'bundled';
}

export function resolveServerModule(context: ExtensionContext): ResolvedServer | undefined {
	const configured = workspace.getConfiguration('js65').get<string | null>('server.path');
	if (configured) {
		// Resolve relative paths against the first workspace folder so a
		// checked-in `.vscode/settings.json` can stay portable.
		const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
		const abs = path.isAbsolute(configured) || !root
			? configured
			: path.join(root, configured);
		if (fs.existsSync(abs)) return { module: abs, origin: 'setting' };
		// An explicit setting that points at nothing is a mistake worth
		// reporting rather than papering over with the bundled copy.
		return undefined;
	}
	const bundled = context.asAbsolutePath(path.join('server', SERVER_BUNDLE));
	if (fs.existsSync(bundled)) return { module: bundled, origin: 'bundled' };
	return undefined;
}

export function serverOptionsFor(module: string): ServerOptions {
	return {
		run: { module, transport: TransportKind.ipc },
		debug: {
			module,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6011'] },
		},
	};
}
