# js65 language server

Two workspace packages:

| Path | Package | What it is |
| --- | --- | --- |
| `lsp/server` | `js65-lsp-server` | stdio LSP server driving the real js65 assembler. No VS Code dependency. |
| `lsp/client` | `js65-vscode` | VS Code extension: grammar, language config, server launcher. No analysis of its own. |

The server builds to a single CommonJS bundle, `build/js65-lsp.cjs`. The
extension ships a copy inside its VSIX and forks it with the extension host's
Node, so end users need neither `bun` nor `node` on PATH.

## Setup

```sh
bun install   # from the repo root, installs both packages
```

`bun` is required for builds; the server bundle comes from `bun build`.

## Building

| Command | Run from | Result |
| --- | --- | --- |
| `bun run lsp` | repo root | `build/js65-lsp.cjs` |
| `npm run build:server` | `lsp/client` | the above, copied to `lsp/client/server/js65-lsp.cjs` |
| `npm run build` | `lsp/client` | `dist/extension.js` (esbuild) plus `out/` (tsc, for tests) |
| `npm run package` | `lsp/client` | `lsp/client/js65-vscode-<version>.vsix` |

Packaging uses `vsce package --no-dependencies`: the extension's dependencies
are hoisted to the workspace root and would be unreachable from the extension
folder otherwise.

## Testing in VS Code

**Extension Development Host.** Open `lsp/client` as the workspace folder (not
the repo root; the launch configs are relative to it) and press F5. A second
window opens on `lsp/client/testFixture/` with the extension loaded from source.
The status bar shows server state; click it or run **js65: Show Language Server
Output** for details. Breakpoints in `lsp/client/src/**` work directly; for the
server, use `autoAttachChildProcesses` or **Attach to Language Server** (port
6011).

**Install the VSIX.**

```sh
cd lsp/client
npm run package
code --install-extension js65-vscode-0.1.0.vsix
```

Reload the window, then open any `.s`/`.asm`/`.inc`/`.mac` file. Uninstall with
`code --uninstall-extension jsnesx.js65-vscode`. On WSL this installs into the
remote (WSL) extension host, which is what you want for sources under `/home`.

**Point at a server you're editing.** Set `js65.server.path` to an absolute path
to bypass the bundled copy:

```json
{ "js65.server.path": "/home/you/js65/build/js65-lsp.cjs" }
```

Rebuild with `bun run lsp` and run **js65: Restart Language Server**. Changing
the setting also restarts the server.

## Automated tests

```sh
bun run test                # repo root: core suite + lsp/server suite
bun run test:lsp            # repo root: builds the bundle, then its suite only
cd lsp/client && npm test   # end-to-end, inside a downloaded VS Code
```

The end-to-end suite downloads VS Code into `lsp/client/.vscode-test/` and
drives the extension through `vscode.execute*Provider`, so every assertion is a
full round trip through the server. Narrow a run with `JS65_TEST_GREP=hover npm
test`.

Headless Linux (including a bare WSL distro) needs Electron's shared libraries.
On Ubuntu 24.04:

```sh
sudo apt install -y libnss3 libnspr4 libasound2t64
```

Without them the run fails with `error while loading shared libraries:
libnspr4.so`.
