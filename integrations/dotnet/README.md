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

### Hermes engine (alternative)

`js65.hermes` is a drop-in alternative to `js65.clearscript` built on the Static Hermes JS engine. Instead
of hosting a JS engine in-process, it ships a small native `js65-hermes` executable and drives it as a subprocess.

```csharp
Assembler asm = new HermesEngine();   // instead of new ClearScriptEngine();
```

Like the ClearScript native libs, the per-platform executables are shipped under `runtimes/{rid}/native/`,
so publishing with an explicit runtime identifier includes only the executable for your target platform:

```sh
dotnet publish -r win-x64    # output contains only js65-hermes.exe (win-x64)
```

The example app accepts a `--hermes` flag to select this engine instead of ClearScript; CI runs it both ways
to verify each engine works on the host platform. You only need to use either ClearScript or Hermes for a desktop
platform, but if binary application size is a concern, then the hermes build is much smaller.

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
