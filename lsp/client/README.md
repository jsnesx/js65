# js65 for VS Code

Language support for js65 6502 assembler, backed by the [js65](https://github.com/jsnesx/js65) assembler itself.

## Features

- **Diagnostics** as you type, with the include/macro-expansion trail attached
  as related information. On save the linker also runs, surfacing
  segment-overflow errors without a build.
- **Go to definition / find references** across a whole assembly unit, including
  through `.include` chains.
- **Document and workspace symbols** for labels, constants, macros, and scopes.
- **Hover** for a symbol's resolved value (hex and decimal) and scope path, the
  addressing modes a mnemonic supports, or a macro's parameter list.
- **Completion** aware of cursor position. Directives after `.`, mnemonics and
  in-scope symbols mid-line, etc.
- **Folding** on `.scope`, `.proc`, `.macro`, `.repeat`, `.struct`, `.enum`.
- **Semantic highlighting** on top of the bundled TextMate grammar.
- **Expand Macro at Cursor** (`js65.expandMacro`).

## Project setup

Add a `js65.json` at the workspace root to describe how your sources fit together

```json
{
  "projects": [
    {
      "name": "main",
      "sources": ["src/**/*.s"],
      "includePaths": ["inc"],
      "target": "nes-nrom"
    }
  ]
}
```

`js65 init` writes one of these, along with a project that builds as it stands.

Each project is one independently assembled program.
Without a `js65.json`, files are analyzed standalone  syntax errors, navigation, and hover still work, and references to symbols defined in other files are reported as warnings rather than errors.

## Language id

This extension contributes the language id `js65` (shown as "js65 Assembly") with grammar scope `source.js65`, for files with the extensions `.s`, `.asm`, `.inc`, and `.mac`.

If you have a different language extension that takes the `.s`, then you can associate them with js65 using the following

```json
{ "files.associations": { "*.s": "js65", "*.inc": "js65" } }
```

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `js65.server.enable` | `true` | Turn the language server off, leaving syntax highlighting only. |
| `js65.server.path` | `null` | Absolute path to a `js65-lsp.cjs` you built yourself. Unset uses the bundled copy. |
| `js65.trace.server` | `off` | Log JSON-RPC traffic to the js65 Language Server output channel. |

## Commands

| Command | Description |
| --- | --- |
| `js65: Expand Macro at Cursor` | Expand the macro invocation under the cursor. |
| `js65: Restart Language Server` | Restart the server, e.g. after changing `js65.server.path`. |
| `js65: Show Language Server Output` | Open the server's output channel. |

## Building from source

Requires [bun](https://bun.sh) on PATH.

```sh
bun install          # from the repo root; this is a workspace package
npm run build        # bundle the extension and compile the tests
npm run build:server # build lsp/server and copy the bundle into server/
npm run package      # produce a .vsix
npm test             # end-to-end suite inside a downloaded VS Code
```

## License

MPL-2.0. See `LICENSE.txt` at the root of the js65 repository.

## AI (LLM) Policy

See `LLMContributions.md` at the root of the js65 repository.
