# `js65` - Patching 6502 Assembler

`js65` is a powerful patching assembler for 6502 that is designed around patching
and modifying existing programs. Written in Typescript, this library provides an interop class to work with the original
assembler through a higher level C# interface.

## Integration

When using the library in a desktop environment, you'll want to use the `ClearScript` based assembler.
This library will include a stripped down V8 build along side of it that will run the core of the project.
ClearScript itself relies on native V8 dlls that `js65.clearscript` references. As long as you publish for
a specific runtime, then only the native runtimes for your target platform will be included in the final application.

```xml
<PackageReference Include="js65.clearscript" />
```

The native libraries are large (~25–50 MB each), so publish with an explicit runtime identifier to ship only
the binary for your target platform:

```sh
dotnet publish -r win-x64    # output contains only ClearScriptV8.win-x64.dll
```

A portable, RID-less `dotnet publish` (or a plain `dotnet build`) instead bundles the native libs for *every*
platform under `runtimes/`, which the runtime resolves at load time. That works, but produces a much larger output.

## Motivation

Often when working on rom hacks for lesser known NES games or making a randomizer, you may not have a complete
disassembly that you can build from. `js65` excels by having the best traits of many assemblers,
simplified `.org` based syntax for overwriting the original data, but also using `.segment` for allowing

Best of all, `js65` has built-in free space tracking, allowing you to easily create patches that fill in empty
space without needing to manually pack addresses by hand! Simply define free space with the `.free` psuedoinstruction
and then any code/data defined in a `.reloc` section will be packed into any free space in the current segment(s). Did I
forget to mention that you can set multiple segments to be active at the same time? This allows you to easily create data
that can spill between fixed and switchable banks, and really squeeze out every last bit of unused space.

## Features

* A familiar ca65 syntax, but with a few new modifications where appropriate
* Available for both desktop and web.
  * The core assembler is written in Typescript and this project provides a C# interop for both .net8 and .net8-browser
* TODO: write more about features here

## TODO

Write a full document explaining how to use it. Check out the example project on github in the meantime or open an issue.

There is an example application with some comments on how to use the assembler.
