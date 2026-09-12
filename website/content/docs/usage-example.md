---
title: Usage Examples
weight: 3
---

This guide is intended to provide a brief overview for how to use `js65` in various ways for each type of project that can benefit from the improvments that `js65` provides.


## Homebrew (New Project)

### Skip the linker script

One of the hardest problem for beginners in `ca65` is learning the custom linker script language.
Getting started in `ca65` almost always requires multiple files, as the linker script is required to be completely separate from the source files that you are building.

`js65` retains the benefits of having a linker while also extending it to make it easier to get started.
The documentation on the different ways to use the extended `.segment` definitions to replace the linker script can be found in the [ASM Guide](/docs/asm-guide).
For a quick example, the following is a segment definition in a source file that describes a basic NROM (mapperless) board with 32kb PRG and 8KB CHR.

```asm6502
; Define some named segments for the RAM sections
; :mem - Defines the PC address for labels
; :size - Number of bytes in the segment
; :zp - defines it as both RAM and marks it as zeropage addressing
; :bss - defines it as a RAM and marks it as ABS addressing
.segment "ZEROPAGE" :mem $0 :size $100 :zp
.segment "STACK" :mem $100 :size $100 :bss
.segment "OAM" :mem $200 :size $100 :bss
.segment "BSS" :mem $300 :size $500 :bss

; :out - Appends this to the final output file (ie: your ROM)
; :fill - Fill in the segment with a default value for :size number of bytes.
.segment "HEADER" :mem $0 :size $10 :out :fill $00
.segment "CODE" :mem $8000 :size $8000 :out :fill
.segment "CHR" :size $2000 :out :fill
```

### Easy to build

Another benefit provided by `js65` is a project file `js65.json` which can simplify making a command line call for the application.
See the [js65.json](#js65-json) section for more details.

If you don't have a project already, you can get started using the following command:

```sh
js65 init <projectname>
```

This will create a very basic folder structure inside `<projectname>` and a corresponding `js65.json` project file as well.
Once you have a `js65.json` setup, then you can use it to build your project with the following command from the project folder:

```sh
js65 build
```

As a bonus, `js65` also has a full Language Server and a [VSCode Extension](https://marketplace.visualstudio.com/items?itemName=jsnesx.js65-vscode) that uses the language server for building and giving full semantic highlighting.
The Language Server works better if you have a `js65.json` present.

### Process assets in source

The [JS Preprocessor](/docs/jspreprocessor) provides a powerful approach to converting assets using a fully stocked javascript engine.
The docs have a full

## Standalone Romhack

While creating a romhack with a fully rebuildable disassembly is preferable to many, `js65` takes out some of the grunt work for working without a disassembly.
If you find yourself wanting to edit a game that doesn't have a full disasm, one of the first things you need to mark what is free space to place your new patches.
In addition to placing patches in free space, you will also want a way to overwrite the original game's code so that it calls your new patches.
`js65` provides easy-to-use and powerful tools for both of these issues.

### Using free space with `.reloc`

The first case is solved through the custom `.free` directive (and the `FREE` / `FREE_UNTIL` helper macros) and `js65` will use these to track what areas are available, and pacl `.reloc` code blocks inside of these free segments.
A common pattern for placing code in free space looks like the following:

```asm6502
.macpack common ; Include the custom FREE/FREE_UNTIL macros

; Mark the range in the segment "BANK1" from $a480 (inclusive) through $c000 (exclusive)
FREE "BANK1" [$a480, $c000)

.segment "BANK1"
; Now when you make a code block relocateable, it will be placed into free space
.reloc
DataBlock:
.byte $00, ; .... more data here

; Call `.reloc` again to end the previous code block and start a new one
; Smaller code blocks helps the linker pack code tightly
.reloc
MyCoolPatch:
  ; ... code here
  rts
```

### Overwriting original game code with `.org`

The second case is solved through using `.org`.
Instead of *only* changing the current PC address used for labels, `.org` actually changes the **output address** as well, so that it overwrites whatever data was there.
`.org` has to be used inside of a `.segment` so that it knows where in the segment it should write, so you will first need to setup the segments to match how the game lays out its banks.

```asm6502
.segment "BANK1"
; Overwrite whatever original game code was here.
; Lets pretend it was originally jsr $9000
.org $94cc
  jsr MyCoolPatch ; Jump to our patch instead
  ; Everything after this is using the vanilla rom data

; Now put our new MyCoolPatch in free space somewhere
.reloc
MyCoolPatch:
  ; do cool new stuff
  ; and then perform the original code or rts if we want to skip it
  jmp $9000
```

One common thing a rom hack may do is patch a function in such a way that the new function is shorter than the original.
In this scenario, `js65` is useful for marking the rest of the unused space as free, while also asserting that the code *doesn't* overwrite code that you want to keep.
The `FREE_UNTIL` macro is perfect for this kind of patch.

```asm6502
.segment "BANK1"
; Let's pretend that this function at $8812 continued until $882b
; and our new patch is much much shorter.
.org $8812
  lda #1
  jmp $8089
; Now we can mark the rest of the space as free AND also assert that
; we didn't start overwriting $882b
; In the future, if someone updated this patch and its now too large,
; then this macro will trigger an error.
FREE_UNTIL $882b
```

### Placing code wherever it fits with pooling

Often times, a game will have a fixed bank, and sometimes you just want your patch to "be available" and you don't care if its in the current bank or the fixed bank.
`js65` has a custom `pool`ed segment attribute to allow code chunks and data to spill from one bank into another.

```
; Shorthand for pooled segments, this means "try to place it in BANK1,
; and if it doesn't fit, place it in FIXED instead"
.segment "BANK1", "FIXED"
.reloc
bank1_or_fixed:
.byte $00
```

### Placing code in multiple banks with mirroring

Sometimes games don't have a fixed bank, and you need to duplicate some shared helper across some or *all* banks in the code.
`mirror`ed segments is a way that lets `js65` output the exact same code across all of the listed banks.

```asm6502
; Lets say we need to place something in BANK1 / 2 / 3

; This is shorthand for the full :mirror attribute, and tells the linker
; that we need to place the following code in ALL of the banks or error out.
.segment "BANK1" & "BANK2" & "BANK3"

; This org will be placed in all 3 of the banks at this fixed address
.org $9000
  jmp MyRelocFunc
  ; ...

; This reloc will be REQUIRED to land in a free space such that
; it will be at the same exact address in ALL of the 3 banks.
.reloc
MyRelocFunc:
  rts
```

## Randomizer

Outside of the benefits with using `js65` as a patching assembler for a randomizer project, `js65` is also designed from the get-go as a library.
There already is a full guide for [using `js65` as a library](/docs/library) so this is just a quick demonstration of features taken from a real randomizer project that uses `js65` as a library.

### Deduplicating data

In the [Zelda 2 Randomizer](https://github.com/Ellendar/Z2Randomizer), we make heavy use of the `:dedupe` feature for segments when setting up the palace layouts.
It's quite common for a palace to generate with some rooms that have the same layout, and to conserve space, we rely on this `:dedupe` feature to make sure that we aren't placing the same room data more than once.
The segment definition itself with `:dedupe` on it isn't all that interesting, but it greatly simplifies the code when we use it.

```cs
    // Place in the pool of segments PRG1C and PRG1C
    sideviewModule.Segment(["PRG1C", "PRG1D"]);
    sideviewModule.Reloc(); // Mark this as relocatable
    sideviewModule.Label(name); // Give it a unique name
    sideviewModule.Byt(sv); // and write the room data.
```

And thats it! Now when `js65` actually **places** the chunk of data representing that palace room, it will search the segments to see if that data already exists.
If it does, then it will "place" it on top of the original one, keeping all of the pointers in the same spot, so now both of the rooms point to the same location for its data.

### Patch based on flags

Randomizers are *notorious* for having tons of customization options, and being able to write relocatable patches is already a huge boon for the rando dev.
But since `js65` is also a library, you can wrap the calls into the library in whatever logic you want.
The following example is just meant to show that all of these different settings can be set directly in the C# code without needing to do hacky string interpolation or writing raw bytes to raw file offsets.

```cs
var a = asm.Module();
a.Set("NO_ENCOUNTERS", allNoEncounters ? 1 : 0);
a.Set("HAS_HALF_ENCOUNTERS", anyHalfEncounters ? 1 : 0);
a.Set("NORMAL_ENCOUNTERS", allNormalEncounters ? 1 : 0);
a.Set("VANILLA_WEST", props.WestBiome.UsesVanillaMap() ? 1 : 0);
a.Set("ENCOUNTER_RATE_PER_CONTINENT", differentRates ? 1 : 0);

if (differentRates)
{
    byte[] encounterTable = [.. encounterRates.Select(o => o.GetAsmByte())];
    a.Segment("PRG0");
    a.Reloc();
    a.Label("EncounterRateRegionTable");
    a.Byt(encounterTable);
}
```


## `js65.json`

`js65` has a command line that will be familiar to users for `ca65`, but we also extend this command line using a custom `js65.json` file that can describe command line calls, letting you store the options into a convenient and shareable file.
When a project is defined in this file, you can use `js65` command line runner to build the project with `js65 build`.
If you run `js65 build` in the directory, then it will all the projects defined in the root `js65.json` file found, or you can build just one with `js65 build <name>`

The json schema file for `js65.json` can be [found here](https://github.com/jsnesx/js65/blob/main/lsp/client/schemas/js65.schema.json) and it provides a full list of all options and accepted types.
Below is just a short example showcasing some of these options.
If you can't find what you want in this example, check the full schema to see if it's there before opening an issue about it.

```js
{
    // Folder to put all project output into by default.
    // This defaults to "build", but you can change it to whatever.
    "outDir": "bin",
    // You can define multiple projects here, each project
    // is basically an output for the source code. This is not a
    // replacement for Make or any other build script, as we don't support
    // anything like rebuilding only out of date files or dep tracking.
    "projects": [
        {
            "allowJavascript": true, // enables use of the JS preprocessor
            "name": "MyCoolProject", // -o - name to use for the output file
            "includePaths": ["."], // -I - list of paths to check for include files from left to right
            "sources": ["main.s", "popslide64.s"], // list of files to build in order from left to right
            "debug": 1, // Sets the debug level. -1 is off, 0 is minimal (includes just labels and comments), 1 is full (includes the full original line as a comment)
            "dbgfile": "MyCoolProject.mlb",
            "features": [
                "c_comments", // enable c style /* */ comments
                "js65_multiops_per_line" // allows multiple opcodes on the same line like `lda #5 clc adc Xspeed sta Xpos` all on one line
            ]
        }
    ]
}
```

