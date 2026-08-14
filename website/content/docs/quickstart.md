---
title: Quickstart
weight: 2
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
