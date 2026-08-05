---
title: Documentation
weight: 1
---

`js65` is a `ca65` compatible assembler, with an emphasis on making it easier to patch existing files.

## Why `js65`?

`ca65` has a very long history and is a popular assembler in the NES community, but it doesn't work as well when you are using it to patch files.
It *can* patch files, but it's hard to do it well, and wouldn't it be nice if you could just have your familiar `ca65` cake but also get to enjoy a [patching-friendly syntax](/docs/patching)?
`js65` fills the gap by [simplifying segment definitions](/docs/asm-guide#segment), [placing code blocks into free space automatically](/docs/asm-guide#reloc), and many more nice-to-have features, all while having an almost perfect recreation of everything else `ca65` already does well.

Additionally, `js65` was designed from the start to allow it to be used as a library in other applications, perfect for randomizers or other projects that want to customize a game with various builds.
The `js65` library gives you full control over the assembly steps, through a [fluent-api builder pattern](/docs/library) that you can control programmatically.
Gone are the days of patching game code by writing giant chunks of raw hex bytes at raw file offsets!

## What else does `js65` offer?

For a more detailed look at the many additions, check out the [ca65 comparison](/docs/ca65-comparison) page.
But for a quick overview of some of the powerful features offered by `js65`

- No linker script needed! Build a rom in one go with [segments defined in the code itself](/docs/asm-guide#segment).
- Free space tracking, let `js65` place code patches wherever there is room.
- Custom Pattern matching [define macro support](/docs/ca65-comparison#custom-define-based-macro-system).

## What's next for `js65`?

- (COMING SOON) Anonymous segment definitions (allowing for single file, top-to-bottom segment layouts)
- (COMING SOON) Built-in LSP support
- (COMING not quite as SOON) VSCode extension for the LSP

## Where do I start?

At the [quick start guide](/docs/quickstart)!
Whether you have a homebrew project, or a romhack, or a randomizer project, there's something useful that `js65` brings to the table.
