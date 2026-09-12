---
title: Library
weight: 7
---

## Use in C# projects

The `js65` C# integration library provides both a desktop library and a browser library for C# WASM exports, both available through the `nuget` package manager.
The base `js65.interop` library provides the common interface, that the desktop and browser libraries will implement.
For desktop support, there are two libraries that run on desktop to provide a javascript runtime.
The `js65.clearscript` uses a natively compiled v8 engine for maximum performance, at the cost of a around 30MB of disk size per platform, while the `js65.hermes` uses an AoT compiled version of `js65` and its about 5x slower and 5x smaller as well.
Which one you choose is up to you, depending on which tradeoff you prefer.
Both have a similar interface, so it isn't too hard to switch between them.

In the `js65` repository, you can find an [example project](https://github.com/jsnesx/js65/tree/main/integrations/dotnet/example) with more details about how to use the C# integration libraries.

## Use in Browsers

`js65` itself is a completely synchronous project by design due to wanting to avoid paying any overhead for async, so to use `js65` in a browser, you will likely want to put it in a shared worker.
Conveniently, we also publish a shared worker API created for the LSP that can be used in a browser as well!

The `js65` Javascript library is designed around loading files and updating files for the LSP, so some things may be a bit more awkward to work with relatively speaking.
Particularly troublesome is handling file IO operations, we can't just make the synchronous worker perform an asyncronous callback into the main process to load a file, so we side step the issue by requiring all files to be preloaded.
To help with this, some of the LSP methods used for preloading files are available as well.
See the section on preloading files on how that can be done.

`Js65Worker` is the main entrypoint for the host side of the shared worker, and it has an async interface for handling the file preloading and compile processes.
The module `js65/worker-client` contains the code for the host side of the process, and `js65/worker` is the module for the shared background worker side that actually runs the compilation.

### Initialization

Browser based initialization:

```ts
import { Js65Worker, browserHostPort } from 'js65/worker-client';

const worker = new Worker('/js65-worker.js', {type: 'module'});
/** You only need to create this once and can reuse it multiple times */
export const js65 = new Js65Worker(browserHostPort(worker));
```

Node.js or Bun initialization:

```ts
import { Worker } from 'node:worker_threads';
import { Js65Worker, nodeHostPort } from 'js65/worker-client';

const worker = new Worker(new URL(import.meta.resolve('js65/worker')));
const js65 = new Js65Worker(nodeHostPort(worker));
```

### Compiling

Instead of providing direct access to the assembler internals, js65 provides `AsmModule` which is a builder object that will produce a list of "commands" to run on the assembler.
This functions the same as if you called the internal methods but without the extra complications surrounding validation, and `AsmModule` even provides as `.code` call for passing in unrestricted assembly inputs.

```ts
import { AsmEngine, sym, type PreloadedFiles } from 'js65/worker-client';
import type { CompileResult } from 'js65';
import { js65 } from './js65.ts';

// when you are ready to compile this, use `AsmEngine.build()` to create the inputs
// list that you can pass to `js65.compile()`
const asm = new AsmEngine();

function exampleModule() {
  // asm.module adds itself to the internal list of modules in the AsmEngine
  // so no need to return it
  const a = asm.module('main');
  // Use `.code` to pass in a whole block of asm directly
  a.code("; any code you want goes here", 'main.s');
  // Or if you have more compilcated needs, you can use the AsmModule's helper
  // methods to create asm directives and statements directly.
  a.segment('CODE');
  a.org(0x8000);
  a.label('itemTable');
  a.byte(items.map(item => item.id));
  // `sym` creates a named symbolic reference like a label or a constant
  a.word(sym('itemTable'));
}

// Below are some example helper functions 
export async function start(files: PreloadedFiles): Promise<void> {
  await js65.ready();
  // Sends all the preloaded file data to the worker. This only needs to be done once
  // and if the files change, you can use `fileChanged` below to update what changed.
  await js65.setFiles(files);
}

/** Call this when you need to update or delete a file on the worker */
export async function fileChanged(path: string, text: string | undefined): Promise<void> {
  await js65.applyFileDelta(text === undefined
      ? {upserts: new Map(), deletes: [path]}
      : {upserts: new Map([[path, text]]), deletes: []});
}

export async function build(baseRom: Uint8Array): Promise<CompileResult> {
  // The backend will try to load included files with these paths later, but you can also
  // just leave them out for a flat file structure as well. See the section on preloading
  // for more information.
  const INCLUDE_PATHS = ['/proj/src', '/proj/inc'];
  const BIN_INCLUDE_PATHS = ['/proj/assets'];
  return await js65.compile({
    request: {
      // `AsmEngine.build()` produces the list of actions for each compilation unit that we are building.
      // If you need to pass in source files, create a module with `AsmEngine.module()` and use `AsmModule.code()`
      inputs: asm.build(),
      options: {
        includePaths: INCLUDE_PATHS,
        binIncludePaths: BIN_INCLUDE_PATHS,
        generateDebugInfo: true,
      },
    },
    baseRom,
  });
}
```

Awaiting the result looks like any other async API.
Note that a compile that fails to assemble still resolves with `success: false` and the diagnostics in `messages`.
The promise only rejects when the worker itself fails, such as a version mismatch or a terminated worker.
Putting this all together, we can check the final output as follows

```ts
const result = await build(editor.getValue(), items, baseRom);
if (!result.success) {
  for (const message of result.messages) {
    // `source` carries file/line/column, which is enough to place an editor marker.
    console.error(`${message.source?.file}:${message.source?.line}: ${message.message}`);
  }
} else {
  // The outputs contains a list of files, because it can contain the actual generated rom image,
  // the debug file, map files, and other outputs defined by the linker script.
  const rom = result.outputs.find(o => o.type === 'binary')!;
  const debug = result.outputs.find(o => o.type === 'debug');
  // Note that result.messages might still have `info`/`warning` level logs in it
  // that you might want to check!
  emulator.load(rom.data, debug?.data);
}
```

### Preloading files

Once you have a `Js65Worker` you can communicate with the service worker process through the async callbacks provided.
But in some cases, the code you are compiling might want to include other files, and in order to do that you must preload all of the possible files it may try to read, so that the worker can read them immediately when needed.
Preloading files is **only** needed when the source files passed in try to include any files at assembly or link time.
This can be done using the `preloadDirectories` helpers in the `js65` project as seen below

```ts
import { preloadDirectories, preloadPaths, type PreloadIo } from 'js65/worker-client';

/**
 * Here's an example fake in-memory file tree setup you can pass in to "preload"
 * for something like a browser IDE that already has all the files in `tree`
 * If you just want a flat file structure, or even try to fetch the data from some
 * remote listing, this can be hooked up to whatever file backing you need.
 */
function memoryIo(tree: Map<string, string | Uint8Array>): PreloadIo {
  return {
    // `fsListDir` form: bare names, with a trailing `/` on directories.
    listDir: (dir) => {
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const path of tree.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        names.add(slash < 0 ? rest : `${rest.slice(0, slash)}/`);
      }
      return [...names];
    },
    readFile: (path) => tree.get(path),
  };
}

// The second param to preloadDirectories is the list of INCLUDE_DIR as if passed in
// through the -I flag on the command line.
const files = preloadDirectories(memoryIo(tree), ['/proj/inc', '/proj/assets']);
preloadPaths(memoryIo(tree), ['/proj/js65.cfg'], files);
```

For `node.js` you can also use the filesystem to preload like the following example.

```ts
import { preloadDirectories } from 'js65/worker-client';
import { nodePreloadIo } from 'js65/preload-node';

// nodePreloadIo wraps the filesystem 
await js65.setFiles(preloadDirectories(nodePreloadIo(), ['/proj/inc']));
```

### Cancelling a build in flight

Sometimes you need to cancel a request, if you need this functionality, then before calling compile, you need to call `peekNextId()` which returns the cancellation ID for the next compile you run.

```ts
let inFlight: number | undefined;

async function rebuild(request: Js65Request) {
  if (inFlight !== undefined) js65.cancel(inFlight);
  inFlight = js65.peekNextId();
  // A compile cancelled while it was running resolves with `success: false` and a
  // cancellation message. One cancelled before the worker ever picked it up rejects
  // instead, so a rebuild loop has to handle both.
  return await js65.compile({request}).catch(() => undefined);
}
```

Cancelling a compile that is already running needs `SharedArrayBuffer`, which browsers only hand out to cross origin isolated pages (`Cross-Origin-Opener-Policy: same-origin` plus `Cross-Origin-Embedder-Policy: require-corp`).
Without it the client still works, but `canCancelRunning` is false and a cancel only takes effect on a request that has not started yet.

## Use through the static-hermes C ABI

This method is the least battle tested, as its not the most friendly way to run Javascript in general.
The `facebook/hermes` library provides an AoT compiled build that can be used as a library through the `js65.h` header.
The `hermes` code is around 5x slower than either the node or bun outputs, but can be compiled into much smaller native code which could be useful for distributing within another project if you are desperate about keeping the size small.
See the `integrations/hermes/js65.h` file for more information about how to use it, and `hermes-build.ts` in the same folder for how we build hermes from source.
The github actions runner also compiles the shared libraries `js65.dll`/`js65.dylib`/`js65.so` which you can use directly in your project as well should building from scratch not appeal to you.

(JS preprocessor is NOT supported when using `hermes` as it doesn't include a JS interpreter)