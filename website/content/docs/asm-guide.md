---
title: ASM Guide
weight: 4
---

`js65` expands on what features `ca65` already offers, so this document is focused on providing extra information about the `js65` specific changes.

Refer to the excellent [ca65 documentation](https://cc65.github.io/doc/ca65.html) for anything not mentioned here.

## `.segment`

In addition to the ca65 `.segment`, there are two additional ways that you can use `.segment`.
The first different type is more of an extension of the existing `.segment`, you can pass in additional segments as long as their `memory` space does not overlap.

```asm6502
; Pretend that PRG2 is defined from memory $8000 - $a000, PRG3 is from $a000 - $c000,
; and PRGFixed is from $c000 - $ffff, then the linker is allowed to place code blocks
; any of the banks listed.
.segment "PRG2", "PRG3", "PRGFixed"
```

The second type of `.segment` is a replacement for `ld65` linker script files.
Instead of splitting the definition of segments into physical `MEMORY` space and a logical `SEGMENT` space, `js65` combines the two concepts into a single `SEGMENT` type.
A `SEGMENT` has the same parameters that both `MEMORY` and `SEGMENT`s have in ld65, and should you need to replicate the same "multiple `SEGMENT`s mapping to a single `MEMORY`" style, then you can accomplish this using the `:load` attribute.

```asm6502
; Define a ld65 MEMORY and SEGMENT section called PRG0
.segment "PRG0" :mem $8000 :off $0010 :out
; Define a SEGMENT only called PLAYER which loads into PRG0
.segment "PLAYER" :load "PRG0"
```

The full list of `.segment` parameters are as follows:

> `:align <num>` - (number must be a power of two) - Places the segment so that the start of the data aligns with the boundary provided by `<num>`.
>
> `:alignload <num>` - (number must be a power of two) - Same as align, but for `:load` segments, sets the alignment only for LOADING and not for RUNNING (which for runtime alignment, you would use `:align`)  
>
> `:bank <num>` - Value set on the segment that can be retrieved with either `.bank(Label)` or `^` which was changed to reference the `.bank` for a Label instead of the upper 16-23 bits (which isn't a thing on NES)
>
> `:bss` - Sets the type to `bss`
>
> `:dedupe` - Custom flag to allow the linker to write blocks on top of already placed blocks. If the linker finds a matching block when placing one, it will overlap the two blocks so that the data can be shared.
>
> `:define` - Create the `__NAME_START__`, etc symbols (see ld65 define = "yes")
>
> `:default` - Marks this segment as the one used when no segments have been set in a file.
>
> `:fill <num>` - If set, fills all data with a specified value. `<num>` is optional, if its not provided, it will fill with 0.
>
> `:load <str>` - Segment name to use as a base for this segment. Any code/data for this segment will be added to the other segment's memory space.
>
> `:mem <num>` - Sets the `org` space for what address this memory starts with.
>
> `:off <num>` - File offset where this segment's data will be written.
>
> `:optional` - Unused. We don't currently throw warnings about unused segments. Kept for ca65 compat until we decide if we want it.
>
> `out <str>` - (`<str>` is optional) File name to write to. Defaults to `"%O"` for the named output file.
>
> `:ro` `:rw` - Unused. Kept for compatbility
>
> `:run <str>` - Sets the `org` for the data that will be used at *runtime* based on the value of the segment that is named in `<str>`.
>
> `:size <num>` - Marks the size of the output data. If `:size` and `:fill` are set, then the entire segment is marked as `free` by default. Otherwise, you will need to `.free` intervals in the code yourself.
>
> `:zp` - Marks this as a zeropage segment (both `bss` and `addrsize = 1`)

## More directives coming soon

## Unimplemented Directives

- Any of the directives that change CPU mode are unimplemented.
- Features are currently not able to be changed during compilation (and options for setting them are not presented to the CLI yet.)
