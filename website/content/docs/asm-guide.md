---
title: ASM Guide
weight: 4
---

`js65` expands on what features `ca65` already offers, so this document is focused on providing extra information about the `js65` specific changes.

Refer to the excellent [ca65 documentation](https://cc65.github.io/doc/ca65.html) for anything not mentioned here.

## `.segment`

`.segment` has several new uses in `js65` in addition to the original ca65 use case. The following are three new overloads to `.segment`

### Pool and Mirror

With the extended segment features, `js65` can place data into a list of segments provided, allowing you to pack data with custom placement rules.
The first placement rule is called segment `pool`ing, allowing data to fill the pool in order of declaration.
Pooling is useful when you want to allow data to spill into the fixed bank when you overflow, or also it can be used to pack data with best fit placement across all banks.
The way pooling decides where to place something is to first group all segments with overlapping memory sections.
From there, segments are filled in the order that they were first DECLARED (not the order they appear in this `.segment` call!)

```asm6502
; Imagine we have this memory layout
.segment "PRG2" :mem $8000 :size $4000 :out
.segment "PRG3" :mem $8000 :size $4000 :out
.segment "PRG7" :mem $c000 :size $4000 :out
; the linker is allowed to place blocks any of the banks listed, and it'll fill them
; first into PRG2/PRG3 according to best fit (ordering by largest block and placing in smallest free space)
; and then spilling into PRG7 when those two are filled.
.segment "PRG2", "PRG3", "PRG7"
; is equivalent to making this segment definition
.segment "MyCoolPool" :pool {"PRG2", "PRG3", "PRG7"}
```

Similar to a `pool`ed segment, you can also do a `mirror`ed segment.
Instead of placing in ANY of the segments, the linker will duplicate the data into ALL segments listed.

```asm6502
; lets say i'm using a mapper that doesn't have a fixed bank, we can create a psuedo fixed bank by copying across all banks
.segment "PRG0" & "PRG1" & "PRG2" & "PRG3"
.org $fffa
.word Reset, Nmi, Irq
.reloc ; will be placed in any spot that is free in ALL banks listed
Reset: ;etc
; mirrored segments can also be created as a named segment as follows
.segment "MyCoolMirror" :mirror { "PRG0", "PRG1", "PRG2", "PRG3" }
```

### Memory Definition

Instead of splitting the definition of segments into physical `MEMORY` space and a logical `SEGMENT` space, `js65` combines the two concepts into a single `SEGMENT` type.
A `SEGMENT` has the same parameters that both `MEMORY` and `SEGMENT`s have in ld65, and should you need to replicate the same "multiple `SEGMENT`s mapping to a single `MEMORY`" style, then you can accomplish this using the `:load` attribute.

```asm6502
; Define a ld65 MEMORY and SEGMENT section called PRG0
.segment "PRG0" :mem $8000 :off $0010 :out
; Define a SEGMENT only called PLAYER which loads into PRG0
.segment "PLAYER" :load "PRG0"
```

The full list of `.segment` parameters are as follows:

* `:align <num>` - (number must be a power of two) - Places the segment so that the start of the data aligns with the boundary provided by `<num>`.
* `:alignload <num>` - (number must be a power of two) - Same as align, but for `:load` segments, sets the alignment only for LOADING and not for RUNNING (which for runtime alignment, you would use `:align`)  
* `:bank <num>` - Value set on the segment that can be retrieved with either `.bank(Label)` or `^` which was changed to reference the `.bank` for a Label instead of the upper 16-23 bits (which isn't a thing on NES)
* `:bss` - Sets the type to `bss`
* `:dedupe` - Custom flag to allow the linker to write blocks on top of already placed blocks. If the linker finds a matching block when placing one, it will overlap the two blocks so that the data can be shared.
* `:define` - Create the `__NAME_START__`, etc symbols (see ld65 define = "yes")
* `:default` - Marks this segment as the one used when no segments have been set in a file.
* `:fill <num>` - If set, fills all data with a specified value. `<num>` is optional, if its not provided, it will fill with 0.
* `:load <str>` - Segment name to use as a base for this segment. Any code/data for this segment will be added to the other segment's memory space.
* `:mem <num>` - Sets the `org` space for what address this memory starts with.
* `:off <num>` - File offset where this segment's data will be written. Can be used to have multiple segments that overwrite the same location.
* `:optional` - Unused. We don't currently throw warnings about unused segments. Kept for ca65 compat until we decide if we want it.
* `:out <str>` - (`<str>` is optional) File name to write to. Defaults to `"%O"` for the named output file.
* `:ro` `:rw` - Unused. Kept for compatbility
* `:run <str>` - Sets the `org` for the data that will be used at *runtime* based on the value of the segment that is named in `<str>`.
* `:size <num>` - Marks the size of the output data. If `:size` and `:fill` are set, then the entire segment is marked as `free` by default. Otherwise, you will need to `.free` intervals in the code yourself.
* `:zp` - Marks this as a zeropage segment (both `bss` and `addrsize = 1`)

### Anonymous

One more way to use `.segment` which is similar to the `Memory Definition` mode is to use it without declaring any name.
This is intended as a quick and easy way to get a project started, as its just a limited shorthand for the full memory definitions described above.

```asm6502
; Make a 16kb bank without a name starting from `.org $8000`
; Most of the same memory definitions can work here too if needed
.segment $8000 :size $4000 :bank 0
; code and data for bank 0 must go here as you can't re-enter a segment
.segment $8000 :size $4000 :bank 1
; this creates a second bank
```

To add code/data to a bank, you need to place the data after the anon segment.

Reserve RAM with `:bss` or `:zp`

```asm6502
.segment $00 :size $0100 :zp
Temp:   .res 2
.segment $0200 :size $0600 :bss
Frame:  .res 1
Scroll: .res 2
; Can also create banked RAM segments
.segment $6000 :size $2000 :bss :bank $0
.segment $6000 :size $2000 :bss :bank $1
```

Just like how ROM anon segments work, you cannot re-enter a RAM segment.

> WARNING - `.include` for defining variables is probably not what you want.

Be careful that you don't use `.include` and put the RAM anon segment declarations into a file that gets `.include`d multiple times.
Each time it is included, it will create duplicates of each of the RAM segment declarations which effectively functions as creating another RAM bank.
This isn't likely what you intended to do, either just include it only once in your main file, or just rely on the multipass assembly feature to handle the symbol resolution across modules for you.

## `.free`

When in `.org` mode, you can mark a size of data as free, and allow the linker to place `.reloc` blocks into these free locations.
If you define a segment with a `:fill` and `:size`, then the linker will also automatically free the entire segment for convenience.
But if you are patching a game, it makes more sense to selectively free chunks of data yourself.

* `.free <sizeInBytes>` takes a single parameter with how many bytes from the *current* org to make free.
For your convenience, in `.macpack common` there are two macros which provide different ways to free data.
* `FREE_UNTIL addr` will mark data as free until the current org `* == addr`, and assert that `* <= addr` for you, that way you can verify that you aren't overriding something important at `addr`.
* `FREE "segmentName" [startAddrInclusive, endAddrExclusive)` The `[` and `)` are included in the `FREE` call. This sets a block of code in the segment `segmentName` as free from start addr up to but not including end addr.

```asm6502
.free $4 ; marks the next 4 bytes as unused

.macpack common
; Not needed if the segment is marked as `:fill` with `:size` since that
; indicates that the whole thing is freed.
FREE "CODE" [$8000, $9000)

.org $9000
; Marks the next $100 bytes as free, but also asserts that the current org
; is not past $9100
FREE_UNTIL $9100
```

## `.strmap`

ca65 includes a basic `.charmap` operation for mapping a single byte to a different single byte, and `.strmap` is the natural extension of this.
It allows you to map any `N` consecutive bytes to `M` output bytes.
All the same rules and restrictions that apply to `.charmap` apply to `.strmap`, so you can `.pushcharmap` and it will also push the current `.strmap`

```asm6502
; Map 10 input bytes to 2 output bytes
.strmap "<newline>", [$00, $fd]
  .byte "Hello!<newline>" ; outputs "Hello!", $00, $fd

; é is the encoded UTF-8 bytes [$C3, $A9] and we can map it to whatever we want 
.strmap "é", $e9
  .byte "café" ; outputs 'c', 'a', 'f', $e9
```

## `.feature`

For the most part, the `feature` list matches what `ca65` supports, but there are some features that are unimplemented in js65 right now, and also some features that are new or different in `js65`.

### New features

* `js65_multiops_per_line` - Allows multiple opcodes per line separated by spaces. For example, this is allowed on one line `lda #4 clc adc $1 sta ObjXCoord+10,x` but `lda foo label: sta $00` because `label:` is not an opcode.
* `js65_backslash_separator` - Enable to make `\` function as a new line character, allowing multiple directives on the same line. EX: `lda foo \ .byte $2c \ skip: lda #1` is allowed since `\` is a line terminator.
* `js65_backtick_separator` - Same as `js65_backslash_separator` but uses `\`` as the new line character instead.

### Different Defaults

* `line_continuations` - On by default (off in ca65)
* `underline_in_numbers` - On by default (off in ca65)
* `leading_dot_in_identifiers` - On by default (off in ca65)

### Always ON features (cannot be disabled)

* `at_in_identifiers`
* `addrsize`
* `string_escapes`
* `loose_string_term`
* `loose_char_term`
* `missing_char_term`
* `org_per_seg`

### Unsupported features

* `long_jsr_jmp_rts` - 65816-only and `js65` doesn't support other CPUs yet.

## `.eol`

Custom directives for improving the ergonomics of `.define` based macros.
`.eol` acts as an "end of line" token, letting your define generate multiple lines of output or it can be used in pattern match define definitions.

```asm6502
; Make a recursive macro that pattern matches for { target @ ... }
; until the end of line token is reached

; Inside the macro we see `.eol` as well, here it is used to let
; .define output a multi line statement.

; It ends by calling itself recursively until there are no more refs
; at which point it calls the base case for the macro
.define UPDATE_REFS {target @ ref refs .eol} \
.org ref .eol \
  .word (target) .eol \
UPDATE_REFS target @ refs

; This is the "base case" for the macro which just matches the .eol token
.define UPDATE_REFS {target @ .eol}
```

## `.noexpand`

`.noexpand` skips define expansion for the next token which you can use to prevent infinite recursion in define based macros.
Macro expansion still happens, this is only preventing `.define` based text replacement for the next token.

```asm6502
; We want to define the base "inclusive start exclusive end" version
; of the FREE macro...
.define FREE {seg [start, end)} \
    .pushseg seg .eol \
    .org start .eol \
    .free end - start .eol \
    .popseg
; ... but also provide a "inclusive start inclusive end" version too.
; To prevent the base case define from expanding right now, we can
; use .noexpand so that it will only get expanded when the below macro
; gets expanded.
.define FREE {seg [start, end]} .noexpand FREE seg [start, end + 1)
```

## `.bankbyte` is just `.bank`

Since js65 is focused on just the NES for now, `.bankbyte` is currently just an alias for `.bank` instead of the upper 16-23 bits.

## Unimplemented Directives

* Any of the directives that change CPU mode are unimplemented.
* Some features are currently not able to be changed during compilation (and options for setting them are not presented to the CLI yet.)
