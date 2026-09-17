---
title: JS Processor
weight: 8
---

## Why Use Javascript to Generate Code / Data?

One consistent issue developers face when making a project is handling asset conversion.
The problem with an assembler that includes custom directives for asset processing in my experience is either so basic that its near useless, or so specific that it doesn't apply to most projects.
So instead of making something too specific or too basic, `js65` hands the keys to the developer to let them develop what they would like.
The JS Processor lets a developer select files to read, use Javascript to process these file inputs, and then generated code and data.
Along side the JS Preprocessor, js65 also has a JS Postprocessor, letting you run a script that executes after the final linking is done, to perform last minute edits to the output.

## Is this secure?

Probably. But just in case it isn't, you must pass in a compile flag to enable it just to be extra safe.
The approach we use doesn't allow the Javascript to run processes, read or write general files, or have host access, but I can't be sure that there isn't some escape path that someone could figure out.
As such, allowing arbitrary code to run from a project does seem like a potential security concern, so it is disabled by default, and you must pass in the `--allow-javascript` flag to enable running user JS blocks.
If you are concerned about building a project using js65, then you can verify if they have javascript enabled by searching the project for the `--allow-javascript` flag.

## Using the JS Preprocessor

The Javascript preprocessor runs before any of the other stages in the assembler and builds the `.js*` directives into runnable Javascript `Function`s.
These functions are later executed as part of the assembler as a regular directive, which allows you to conditionally control the execution with the standard preprocessor directives.
Note that while the execution is handled with a custom `.jsaction` directive, the inputs and modules are preloaded durnig the JS preprocessor stage, so running a `.jsinput` directive twice is an error.

## Using the JS Postprocessor

The Postprocessor differs only slightly from the preprocessor in when the execution happens and what values are available at this stage.
Instead of running during assembly time, the Javascript code blocks are saved into the module so that it can run after the linking is fully complete.
At this stage, you have access to two new values: `rom` containing the final output, and `labelMap` containing a map of all label names (see [Predefined Global Values](#predefined-global-values))
Postprocessing blocks of code are collected before assembly even runs, so it's not possible right now to enable/disable them with conditional assembly statements.

## Directives

### `.jsinput`

Declares a file or glob/list of files that should be included in EACH of the `js` blocks in the file.
Takes two parameters, the first is a variable name that the file or list of files will be called in the script.
The second is a string path for the file or files to load (files if the `*` glob is used)
The path currently does not accept path globbing `**` operations.

```ts
declare interface JsInputFile {
  path: string;
  bytes: Uint8Array;
  text: string;
}
```
```asm6502
; `*` makes this a glob input, so it creates a variable `graphics` with type `JsInputFile[]`
.jsinput graphics, "raw/*.bmp"
; Single file, so it creates a variable `data` with the type `JsInputFile`
.jsinput data, "foo.dat"
```

### `.jsmodule`

Includes a prebuilt module of javascript helper files with `.jsmodule <name>`
Currently, js65 includes the following two modules.

- `bmp` - Port of `bmp-js` under the MIT license (see 3rd party licenses). [Documentation](#bmp-module-example-and-interface)
- `png` - Port of `upng` under the MIT license (see 3rd party licenses). [Documentation](#png-interface)

### `.jsbegin`

Starts a JS block and compiles into a runnable `.jsaction`.
This action can be conditionally compiled along side other normal preprocessor directives.
See the [Example](#Example) to see it in action, and see [Predefined Global Values](#predefined-global-values) for details on the global variables available.

### `.jsend`

Ends a JS block started with `.jsbegin`

### `.jsaction`

This is what the `.jsbegin`/`.jsend` block turns into internally.
Since it is an assembly directive, that means it respects the current processing state for the assembly unit.
In other words, if you surround the `.js` block with `.if 0` it WILL NOT EXECUTE because the `.jsaction` itself will be guarded by that conditional.
This also means that you can intentionally run a `.jsaction` yourself by typing out `.jsaction <num>` where `num` is the zero based index from the start of the file for that particular `.js` block.
It ALSO means that you may unintentionally run a `.js` block multiple times if you put this in a header file that is included in multiple places, so be careful.

### `.jspostbegin`

Creates a Javascript code block that will be executed after the final output rom is generated.
This directive is processed before assembly starts and it does not generate a `.jsaction`-like directive, so `.jspostbegin` cannot be conditionally compiled as part of assembly.
Any post blocks will always be executed unconditionally after the linking is complete.
There is no assembly output at this stage, any changes you make should be made directly to the `rom` buffer itself.
The compiled list of labels are available at `labelMap` for you to use to gather offsets as needed.

### `.jspostend`

Ends a block that started with `.jspostbegin`

## Predefined global variables

### Preprocessing

Inside a `.js` block, there are two global variables `a` and `defines` that are always present.
`a` is of type `AssemblyAction` and allows you to create output assembly statements from inside JS.
This is the same as using js65 as a library, but its missing the `a.code` for now, until we decide if its useful or not to allow full assembly inside a js block.
The `.jsaction` itself runs inside the current assembly context, so whatever `.segment` and `.org` are in use at the time the `.jsaction` executes is what will be used, and by extension, any `.org` changes made inside the `.jsaction` will apply to the rest of the assembly file too. 

```ts
export type AssemblyAction =
  | { action: 'label', label: string, source?: ActionSource }
  | { action: 'byte', bytes: Array<number | string | { op: 'sym', sym: string }>, source?: ActionSource }
  | { action: 'word', words: Array<number | { op: 'sym', sym: string }>, source?: ActionSource }
  | { action: 'hibytes', values: Array<number | { op: 'sym', sym: string }>, source?: ActionSource }
  | { action: 'lobytes', values: Array<number | { op: 'sym', sym: string }>, source?: ActionSource }
  | { action: 'literal', values: Array<number | string | { op: 'sym', sym: string }>, source?: ActionSource }
  | { action: 'org', addr: number, name?: string, source?: ActionSource }
  | { action: 'segment', name: string | string[], source?: ActionSource }
  | { action: 'reloc', name?: string, source?: ActionSource }
  | { action: 'export', name: string, source?: ActionSource }
  | { action: 'exportzp', names: string[], source?: ActionSource }
  | { action: 'import', names: string[], source?: ActionSource }
  | { action: 'importzp', names: string[], source?: ActionSource }
  | { action: 'global', names: string[], source?: ActionSource }
  | { action: 'globalzp', names: string[], source?: ActionSource }
  | { action: 'assign', name: string, value: number | string, source?: ActionSource }
  | { action: 'set', name: string, value: number | string, source?: ActionSource }
  | { action: 'free', size: number, source?: ActionSource }
  | { action: 'align', boundary: number, fill?: number, source?: ActionSource }
  | { action: 'res', count: number, value?: number, source?: ActionSource }
  | { action: 'charmap', code: number, target: number, source?: ActionSource }
  | { action: 'strmap', key: string, bytes: number[], source?: ActionSource }
  | { action: 'pushcharmap', source?: ActionSource }
  | { action: 'popcharmap', source?: ActionSource };

// Example usage for the `a` global variable
a.segment("CODE");
a.org(0x8123);
// a.sym generates the { op: 'sym' } type mentioned above to let you reference a symbol or label
a.word(a.sym("MyCustomTable"));
a.reloc();
a.label("MyCustomTable");
a.byte(0x00, 0x00); // Data can go here
```

The `.jsaction` is also able to access the current symbol state, to allow you to access constants provided both through the CLI with `-D` and whatever is set in the current assembly unit.
The JS block is compiled at preprocess time but the code itself does not run until the `.jsaction` is reached, so `defines` reflects the assembly state at exactly that point.

```ts
// Doing `defines.A` performs a lookup in the assembler's symbol table.
declare const defines: Record<string, number | undefined>;
```

Every name is referenced live from the assembler's symbol table as it stands when the block runs, using the current scope the `.jsaction` sits in.
A numeric `-D` on the command line is assigned as an ordinary symbol before assembly starts, so it reads back here like any other constant.
A symbol that isn't defined yet, is a forward reference, or is only resolvable at link time (a label address, an import) reads back as `undefined`.
A non-numeric `-D` (`-D NAME=game`) is a textual replacement, not a symbol, so it is deliberately not visible in `defines`.

```ts
BASE = 7
.jsbegin
// writes 8, because BASE is already assigned above this line
a.byte(defines.BASE + 1);
.jsend
```

### Postprocessing

Inside of a `.jspostbegin` block, the following two values are passed in.

```ts
/**
 * \`.jspostbegin\` only. Copy of the final linked ROM, which becomes the output once
 * every block has run. Can be grown with \`rom.buffer.resize(n)\`.
 * If you are writing a \`.jsbegin\` block and want data from the original rom
 * that you are patching, see \`.baserom\` instead.
 */
declare const rom: Uint8Array<ArrayBuffer>;

export type MesenLabelFormatType = "NesMemory"|"NesPrgRom"|"NesInternalRam"|"NesSaveRam"|"NesWorkRam";
export interface MesenLabelFormat {
  type: MesenLabelFormatType,
  start: number,
  /** Exclusive */
  end: number,
  label: string,
  comment: string,
}

/**
 * \`.jspostbegin\` only. Debug labels keyed by label name, empty unless the
 * link generates debug info.
 */
declare const labelMap: ReadonlyMap<string, MesenLabelFormat>;
```

## Example

### Writing Bytes

```js
.jsbegin
// `a` is described in the section `Predefined global values`
a.byte("Hello World!");
// is the same as doing `.byte "Hello World!"`

// which then turns into `.jsaction 0` to run the JS function
.jsend
```

### Processing Images

See the `bmp` and `png` examples below.

## `bmp` Module Example and Interface

```ts
type Rgb = [number, number, number];
type EncodeBitDepth = 1 | 4 | 8 | 16 | 24 | 32;

interface LoadOptions {
  palette?: readonly Rgb[];
  exact?: boolean;
}
interface IndexedImage {
  width: number;
  height: number;
  pixels: Uint8Array;
  palette: Rgb[];
}
interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}
interface EncodeOptions {
  bits?: EncodeBitDepth;
  palette?: readonly Rgb[];
}
interface BmpApi {
  load(bytes: Uint8Array, opts?: LoadOptions): IndexedImage;
  loadRgba(bytes: Uint8Array): RgbaImage;
  encode(image: RgbaImage | IndexedImage, opts?: EncodeOptions): Uint8Array;
  lib: unknown;
  // lib is the internal `bmp-js` in case you need more access
}
```
```ts
// Example:
.jsinput graphics, "raw/*.bmp"
.jsmodule bmp
.jsbegin
for (let g of graphics) {
    var img = bmp.load(g.data, {palette:[0xf, 0x10, 0x16, 0x28], exact: true});
    // get a filename out of the path we loaded
    const filename = g.path.split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
    // pretend we have a toCHR function that handles
    a.label("Data_" + filename);
    a.byte(toCHR(img.pixels));
}
.jsend
```

## `png` Interface

```ts
type Rgb = readonly [number, number, number];
interface LoadOptions {
  palette?: readonly Rgb[];
  exact?: boolean;
}
interface IndexedImage {
  width: number;
  height: number;
  pixels: Uint8Array;
  palette: Rgb[];
}
interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}
interface EncodeOptions {
  palette?: readonly Rgb[];
  colors?: number;
}
interface PngApi {
  load(bytes: Uint8Array, opts?: LoadOptions): IndexedImage;
  loadRgba(bytes: Uint8Array): RgbaImage;
  encode(image: unknown, opts?: EncodeOptions): Uint8Array;
  upng: unknown;
  // upng is the internal library thats backing this
}
```

The usage should be pretty similar to the `bmp` example.
