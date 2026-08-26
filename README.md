# js65

CLI and library for assembling, linking, patching, and smudging 6502 assembly code

## Installing

[Visit the website to download it](https://jsnesx.github.io/js65/download/) or install it with npm using

```bash
npm install -g js65
```

## Basic usage

js65 has a similar command line structure to `ca65` so check `--help` for more information.
js65 has a few commands available for getting started

* `js65 init <projectName>` - Creates a very basic NES rom template in the folder `<projectName>`
* `js65 build` - Compiles the project as described in file `js65.json` (see the docs for info) This isn't intended to replace a `Makefile` or any other build system, its just a bare bones way to compile a ROM for beginners. You can still build with standard compiler options and use js65 in make or cmake or batch or whatever.

Some popular flags that should be noted are as follows:

* `-c` - Compile only and skip linking. Generates an object file output that can be linked later. (Note that object files are not guaranteed to work between js65 versions)
* `-o <OutputName>` - the file name to use for the output
* `-r <BaseRom>` - declares the original ROM image you want to patch on.
* `--no-lint` disables the linter warnings for common issues people run into. Lint warnings can be disabled individually with `-W-no-lint_name_here` if you want some warnings and not others.

## Why js65

js65 bring the familiar syntax of ca65, but with many new powerful additions that I've always wished it supported.
For a short list of cool features we have that ca65 doesn't support, see below:

* Multipass support, skip `.import/.export` and freely use `.bank` in `.if` conditionals if you wish. We can figure out whats in ZP just fine without you needing to tell the assembler.
* No need for linker scripts! Extended segment definitions allow defining linker layout inside the assembler.
* Built for romhacking/patching existing games. Use `.org` to set an address to overwrite and `.reloc` to place data in unused area
* Free space tracking. Mark area in a rom as unused with `.free` and allow the linker to pack your code for you.
* Pooled and mirrored segment placement. Pooled code will be placed in ANY of the segments in the list, and mirrored code is guaranteed to be duplicated into ALL segments in the list.
* Native Language Server available with a VSCode extension.
* Create a clean disassembly with `clean`/`smudge` to create a file without any copyrighted code or data, and can be filled back in with the original game rom.
* Can be used as a library to build your asm patches at runtime. No more randomizers with hardcoded hex byte patches please!
* Natively supports the web browser.
* New powerful pattern matching `define` based macros. (See `FREE_UNTIL` and `UPDATE_BYTE` for instance)
* New directives like `.strmap`
* `ld65` linker script backwards compatibility.
* And more stuff I'm probably forgetting.

## Why not js65

* No C support and its not the radar right now either.
* Ca65 is faster and will very likely always be faster.
* Not compatible with `od65` object files. Similarly theres no static lib support (`.a` files)
* Native binary sizes for the compiler will always be larger since we use Typescript.
* Currently no support for other cpus besides the 6502.
* Not 100% ca65 compatible and never will be fully 100% compatible (but js65 is pretty close).
* Your disdain for Gen AI prevents you from using any projects marred by it's touch whatsoever.

## Contribution Policy

* Human contributions are very welcome!
  * This project was started by humans many years ago and was maintained solely by us humans for years. Nothing wrong with that ;)
* There must be a human behind all of the contributions.
* This human should write their own documentation, commit messages, comments, and PR descriptions.
  * If you (the human) can't explain the code yourself without an LLM's assistance, don't submit it!
  * AI generated text is very often slop, and it will hurt your chances of getting the contribution merged.
  * There is some leeway here as sometimes the LLM comments are sometimes okay enough.
* LLM generated test cases are acceptable.
  * We encourage you to still read through the generated tests to make sure it covers the scope of your feature.
* LLM generated code is *mostly* acceptable.
  * We hold the right to reject if it seems like there isn't enough manual due diligence behind the change.
  * You should think carefully about the impact of your changes, LLMs love to slam in new code instead of working it into the existing codebase.

## LLM/AI Disclosure

* js65 is an older project ([from humble beginnings as a single file assembler in 2018](https://github.com/crystalis-randomizer/crystalis-randomizer/blob/c04692fecf5d1ee4348056766f2467c41671b794/6502.js)). We worked on it before AI and should AI explode in a fire tomorrow, we will continue on it without AI.
* Several new features are generated in part by LLMs with careful manual human review.
* Test cases are generated by LLMs.
* Some ancillary features are written wholly with LLM generated code and not as much human review as it should've received (such as the static hermes integration or the LSP).
