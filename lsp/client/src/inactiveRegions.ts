// SPDX-License-Identifier: MPL-2.0

/**
 * Greys out the conditional branches the assembler did not take, the way a C
 * editor greys out an untaken `#if`. The server pushes the line ranges after
 * every analysis pass; this module only paints them.
 */

import * as vscode from 'vscode';
import type { LanguageClient } from 'vscode-languageclient/node';

/** Payload of the server's `js65/inactiveRegions` notification. */
interface InactiveRegionsParams {
	uri: string;
	/** 0-based, end-exclusive line spans. */
	regions: Array<{ startLine: number; endLine: number }>;
}

const NOTIFICATION = 'js65/inactiveRegions';

/** Configuration key controlling whether the dimming is painted at all. */
const ENABLE_SETTING = 'js65.inactiveRegions.enable';
const OPACITY_SETTING = 'js65.inactiveRegions.opacity';

/** Rebinds the notification handler to the current client after a restart. */
export type RebindInactiveRegions = (client: LanguageClient) => void;

export function registerInactiveRegions(
	context: vscode.ExtensionContext,
): RebindInactiveRegions {
	// Last payload per document, kept because a decoration only survives while
	// its editor is open: reopening a file has to repaint from something.
	const known = new Map<string, InactiveRegionsParams['regions']>();
	let decoration = createDecoration();

	context.subscriptions.push(new vscode.Disposable(() => decoration.dispose()));

	const repaint = (editor: vscode.TextEditor | undefined): void => {
		if (!editor || editor.document.languageId !== 'js65') return;
		const spans = known.get(editor.document.uri.toString()) ?? [];
		editor.setDecorations(decoration, spans.map(toRange));
	};

	const repaintAll = (): void => {
		for (const editor of vscode.window.visibleTextEditors) repaint(editor);
	};

	context.subscriptions.push(
		vscode.window.onDidChangeVisibleTextEditors(editors => {
			for (const editor of editors) repaint(editor);
		}),
		vscode.workspace.onDidCloseTextDocument(doc => {
			known.delete(doc.uri.toString());
		}),
		// The decoration bakes in its opacity, so a settings change needs a new
		// one rather than just a repaint with the old object.
		vscode.workspace.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration('js65.inactiveRegions')) return;
			decoration.dispose();
			decoration = createDecoration();
			repaintAll();
		}),
	);

	// The client is recreated on every restart, so the caller rebinds against
	// whatever client is current. The old handler dies with the old client.
	return (client: LanguageClient) => {
		// A restarted server replays everything, and the previous run's ranges
		// are about to be stale, so start from nothing.
		known.clear();
		repaintAll();
		context.subscriptions.push(client.onNotification(
			NOTIFICATION, (params: InactiveRegionsParams) => {
				known.set(vscode.Uri.parse(params.uri).toString(), params.regions);
				repaintAll();
			}));
	};
}

/**
 * A whole-line range for one span. `endLine` is exclusive, but `isWholeLine`
 * paints every line the range touches, and a range ending at `(endLine, 0)`
 * touches `endLine`. Stopping at the end of the line before it is what keeps
 * the dimming off the `.endif` that closes the block.
 */
export function toRange(span: { startLine: number; endLine: number }): vscode.Range {
	const last = Math.max(span.startLine, span.endLine - 1);
	return new vscode.Range(span.startLine, 0, last, Number.MAX_SAFE_INTEGER);
}

function createDecoration(): vscode.TextEditorDecorationType {
	const config = vscode.workspace.getConfiguration();
	if (!config.get<boolean>(ENABLE_SETTING, true)) {
		// A decoration that paints nothing is simpler than threading an
		// "enabled" flag through every repaint path.
		return vscode.window.createTextEditorDecorationType({});
	}
	const opacity = clampOpacity(config.get<number>(OPACITY_SETTING, 0.55));
	return vscode.window.createTextEditorDecorationType({
		isWholeLine: true,
		// Fades the text without repainting it, so semantic colours still show
		// through the way they do in a dimmed C `#if`.
		opacity: `${opacity}`,
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});
}

function clampOpacity(value: number): number {
	if (!Number.isFinite(value)) return 0.55;
	return Math.min(1, Math.max(0.1, value));
}
