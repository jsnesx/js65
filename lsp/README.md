# js65 language server

Two workspace packages:

| Path | Package | What it is |
| --- | --- | --- |
| `lsp/server` | `js65-lsp-server` | Independent LSP server driving the js65 assembler. |
| `lsp/client` | `js65-vscode` | VS Code extension |

## Setup

```sh
bun install   # from the repo root, installs both packages
```

`bun` is required for builds as the package tree comes from `tsc`.

## Building

| Command | Run from | Result |
| --- | --- | --- |
| `bun run build:npm` | repo root | `dist/`, including `dist/lsp/server` |
| `bun run build:server` | `lsp/client` | the above, copied to `lsp/client/server/` |
| `bun run build` | `lsp/client` | `dist/extension.js` (esbuild) plus `out/` (tsc, for tests) |
| `bun run package` | `lsp/client` | `lsp/client/js65-vscode-<version>.vsix` |

## Testing in VS Code

**Install the VSIX.**

```sh
cd lsp/client
bun run package
code --install-extension js65-vscode-<version>.vsix
```

Reload the window, then open any `.s`/`.asm`/`.inc`/`.mac` file. Uninstall with
`code --uninstall-extension jsnesx.js65-vscode`. On WSL this installs into the
remote (WSL) extension host, which is what you want for sources under `/home`.

**Point at a server you're editing.** Set `js65.server.path` to an absolute path
to bypass the bundled copy.

```json
{ "js65.server.path": "/home/you/js65/integrations/npm/js65.mjs" }
```

Rebuild with `bun run build:npm` and run **js65: Restart Language Server**.
Changing the setting also restarts the server.

## Automated tests

```sh
bun run test                # repo root: core suite + lsp/server suite
bun run test:lsp            # repo root: builds the bundle, then its suite only
cd lsp/client && bun run test   # end-to-end, inside a downloaded VS Code
```

The end-to-end suite downloads VS Code into `lsp/client/.vscode-test/` and
drives the extension through `vscode.execute*Provider`, so every assertion is a
full round trip through the server. Narrow a run with `JS65_TEST_GREP=hover bun
run test`.

Headless Linux (including a bare WSL distro) needs Electron's shared libraries.
On Ubuntu 24.04:

```sh
sudo apt install -y libnss3 libnspr4 libasound2t64
```
