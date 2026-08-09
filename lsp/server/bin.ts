// SPDX-License-Identifier: MPL-2.0

/**
 * stdio entry point for the js65 language server.
 *
 * Run via `node build/js65-lsp.cjs` (produced by `bun run lsp`); any LSP client
 * (Neovim, Helix, VSCode, Zed, ...) spawns it as a child process.
 */

import {main} from './server.ts';

void main().catch((err) => {
  console.error('js65-lsp: fatal error', err);
  process.exit(1);
});
