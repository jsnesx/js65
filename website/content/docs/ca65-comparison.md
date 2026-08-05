---
title: ca65 comparison
weight: 5
---

This guide is a quick reference for someone who already knows ca65 and is interested in seeing whats different.

## Patching

`js65` includes a new `-r` option for setting a `baseROM` image, which treats the rest of your code as overwriting the data in that file.
When you configure `segments` (either with a `ld65` linker script or using the new [.segment](#segments-expanded) expanded syntax), you are configuring where the data for the code gets assembled to, but unlike in a standard assembler, the data will be laid out on top of the `base`.
For more information on the specifics of patching see the [`Patching`](/docs/patching) guide.

## Segments expanded

The `.segment` directive allows for an alternate syntax that can be used to *DEFINE* a segment instead of just placing data into a segment.
In `ca65` terminology, the expanded `.segment` directive creates a linker script `MEMORY` section and an associated `SEGMENT` that loads the `MEMORY` section with the same name.
As a quick example, we can define the `CODE` and `VECTORS` segment for a NES NROM game with the following block.

```asm6502
; Define a MEMORY and SEGMENT called CODE with the following attributes
; :off - wires this segment to patch at file offset $10 (skipping over the iNES header)
; :mem - sets the `.org` address for this segment
; :out - writes to the output file (or optionally a string param for a filename)
.segment "CODE" :mem $8000 :size $8000 :off $0010 :out
; switch the output to use the CODE segment
.segment "CODE"
; Don't need to make a VECTORS segment when we can choose what address to write to
; `.org` works in the current CPU address space, so it will be placed at the end of "CODE"
.org $fffa
.word ResetPatched
; ... any other VECTORS can go here if you wanted to patch it
```

If you still need to have a plain `SEGMENT` that loads into a different `SEGMENT`, `js65` supports the `:load`, `:run` parameters.
For more information, see the examples in the [`.segment`](/docs/asm-guide#segment) documentation

## `.free` / `.org` / `.reloc`

One of the defining features of a patching assembler is allowing the linker to place your patches wherever there is free space.
Sections of a segment can be marked as `free` allowing the linker to place patches inside those blocks.
Use the `.reloc` directive to switch the output into relocatable segment mode, which will put code blocks into free space.
Here's an example using the a new banked style segment definition.

```asm6502
.macpack common ; Includes js65 specific macros like FREE and FREE_UNTIL

; Imagine we have a game which has 7 switchable 16kb banks and 1 16kb fixed bank at the end.
; Other segment definitions removed for brevity.
.segment "PRG2"   :bank $02 :size $4000 :mem $8000 :off $08010
.segment "PRG7"   :bank $07 :size $4000 :mem $c000 :off $1c010

; By including both segments here, we can allow patches to end up in either
; (provided their :mem region doesn't overlap!)
.segment "PRG2", "PRG7"

; Mark some space as free that we know the original game doesn't use.
; The opening [ denotes an inclusive address, and the closing ) denotes an exclusive address 
FREE "PRG2" [$8123, $8843)
FREE "PRG7" [$dd14, $de00)

; Now for the example. Lets patch this function in PRG7 to call our new code.
.org $c99a
  jsr MyCustomPatch
  ; Anything else written here will keep writing to $c99d and beyond

; Switch the output to write into free space in this segment(s).
; NOTICE: since we declared both "PRG2", "PRG7" as possible segments, you should
; be sure that this patch is only ran when both banks are banked in.
.reloc
MyCustomPatch:
  ; ... your code here is placed in the free space in either "PRG2" or "PRG7"
  rts
; Anything else written here will be placed as part of this code block.

; If you want a second patch that can be moved anywhere in free space, then you just need
; to use another `.reloc`
.reloc
DifferentPatchPlacedIndependently:
  ; This patch code will be placed into free space completely separate from `MyCustomPatch`
  rts
```

## `.align`

Works similarly to `ca65` overall, but is tweaked a bit to work with placing data with `.reloc`.
If `.align` is used in a code block (see [.reloc](/docs/asm-guide#reloc) for more details on code blocks) then the entire code block is forced to start with that alignment.
This alignment can *only* be used with `.reloc` code blocks, as it requires the linker to place the code freely.
If `.align` is used at the end of a code block, it still applies to the entire code block.
Any of the padding surrounding the alignment is considered free space and patches may still be placed inside that space.

## Byte sharing `:dedupe` (js65-only feature)

When placing segments, `js65` allows a segment to opt in to deduplication.
If a segment has `:dedupe` enabled, then each code block (smaller than 256 bytes) is compared against all other placed code blocks and if a match is found, it will be assigned to overlap matching one.
Any pointers to data within the code block are properly reassigned to this location, allowing the chunks to share data.
As this has the potential to create unintended consequences, `:dedupe` is opt-in on segments.

## `+++` Anonymous label syntax

A breaking change from `ca65`, anonymous labels use the `+` / `-` syntax and are essentially expanded into named local labels.
In other words, in `ca65` the number of `+` pluses count ahead that many labels, but in `js65` its just an acceptable name for a local label.
In practice this means that this code is totally fine

```asm6502
lda Value
; this is NOT jump 3 labels ahead. its just branch to the label named +++
bne +++
  jmp ++
; Labels don't need a `:` in js65
+++
sta $01
rts
; .reloc doesn't end the current anon label scope
.reloc
; so we can still reference this ++
++
  sta $00
```

## Custom `define` based macro system

In addition to the `ca65` `.macro` and `.define` syntaxes, a new, powerful pattern matching `.define` syntax is also available.
This `.define` lets you make custom macros that pattern match on the input as parameters.
The easiest way to explain this is with a heavily commented example.

```asm6502
; This macro can be used to replace several locations with the target address.
; Say you want to relocate a function, but need to patch all of the original
; callers of it.

; The macro body defintion says to match the parameter list surrounded by {}
; and name each space-separated parameter

; The '@' is pattern matched to the input that the user provides, there's nothing
; particularly special about using the @ sign, its just a token to visually separate
; it for the caller.

; The first parameter target is whatever is before the @ sign, and the `ref`
; is the next input after the @ sign.
; Anything up till the end of the line `.eol` is matched as part of the `refs` parameter

; .eol allows you to make multi-line defines as they will be replaced by a newline
; character when the substitution happens.

; This first define sets up the "list" version that takes 1 or more inputs
.define UPDATE_REFS {target @ ref refs .eol} \
.org ref .eol \
  .word (target) .eol \
UPDATE_REFS target @ refs

; This next part defines the base case which takes zero inputs and ends.
; And now, the macro works recursively, it runs `.org` / `.word` for each
; ref in the list, and sets the target there until it runs out of refs.
.define UPDATE_REFS {target @ .eol}
```
