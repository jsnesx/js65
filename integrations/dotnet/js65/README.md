# `js65` - Patching 6502 Assembler

`js65` is a powerful patching assembler for 6502 that is designed around patching
and modifying existing programs. Written in Typescript, this library provides an interop class to work with the original
assembler through a higher level C# interface.

## Integration

When using the library in a desktop environment, you'll want to use the `ClearScript` based assembler.
This library will include a stripped down V8 build along side of it that will run the core of the project.
ClearScript itself relies on native V8 dlls, so in addition to adding this package, you'll want to conditionally add the `ClearScriptNative` packages for each platform.
Make sure that the version matches the same version that `js65` uses.

```xml
<PackageReference Include="Microsoft.ClearScript.V8.Native.linux-x64" Version="7.4.5" Condition="$([MSBuild]::IsOsPlatform('Linux'))" />
<PackageReference Include="Microsoft.ClearScript.V8.Native.osx-arm64" Version="7.4.5" Condition="$([MSBuild]::IsOsPlatform('OSX'))" />
<PackageReference Include="Microsoft.ClearScript.V8.Native.win-x64" Version="7.4.5" Condition="$([MSBuild]::IsOsPlatform('Windows'))" />
```

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
