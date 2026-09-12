---
title: Quickstart
weight: 1
---

There are a few ways to install `js65` for your platform of choice

## Install on desktop using `npm`

`js65` is available as both a library and binary package on `npm`.
A recent version of [nodeJS](https://nodejs.org) is required to run this version.

```sh
npm install -g js65
```

## Install on desktop using prebuilt binaries

There are a few different prebuilt binaries for `js65` available on [GitHub](https://github.com/jsnesx/js65/releases).
In the releases section, there are the following prebuilt binaries available for download, and you can choose which one you want to use based on your preference of compile speed vs. disk size.
It is recommended to rename whichever file you choose to `js65` to use.

> `bun` (preferred) - Largest file size, fastest execution speed.
>
> `hermes` - Small file size, medium-fast execution speed.

## Start a new project

We provide a simple starter template to get you up and running as fast as possible.
This starter project uses a NES NROM default, but it can easily be extended to support whatever mapper or board you want.
Create a new project folder using the template with the following command:

```sh
js65 init <projectname>
```

Inside the folder `projectname` you will find a basic `js65.json` file that describes the compile command used to build the project.
If you add new files to build, update the `srcs` list in the `js65.json` file to include your new sources.
Compiling your project can be done with the following command:

```sh
js65 build
```

And you will see the `projectname.nes` folder in the `build` directory!

`js65` can be used with `GNU Make` or any other build platform as well, and if you get to the point where you have a large project that takes a long time to build, it would help to use these as `js65` will fully recompile all source files each build.
Build tools like `make` or `cmake` can properly track dependencies and only rebuild affected files, so there is still benefits to using these projects, but you can still use `js65.json` for the language server integration, and `js65 build` for quick one-off builds.

## Build and run

Use `js65 --help` to see the command line options.
Common options are listed below

```sh
-o # choose the output file name
-c # compile only
-C # use a ld65 linker script instead of extended segment definitions
-g[n] # (default on) enables debug info collecting. The number can be 0, 1, or 2 which progressively more debug info added for each number.
--dbgfile <name> # name of the file to write the mlb file to.
```
