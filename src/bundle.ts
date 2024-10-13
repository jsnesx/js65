
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// import * as path from "std/path/mod.ts";
// import * as esbuild from "esbuild";

// function getConfigPath(importMeta: ImportMeta): string {
//   return path.resolve(path.dirname(path.fromFileUrl(importMeta.url)), "deno.jsonc");
// }
  
// const cfgPath = getConfigPath(import.meta);

// await esbuild.build({
//   plugins: [...denoPlugins({configPath: cfgPath})],
//   entryPoints: [
//     'src/cli.ts'
//   ],
//   bundle: true,
//   minify: true,
//   platform: "neutral",
//   target: ["es2020"],
//   outfile: 'build/cli.js',
// });
// esbuild.stop()

await Bun.build({
  entrypoints: ['./js65.ts'],
  outdir: '../build/',
  minify: true, // default false
  target: 'browser', // default
  format: "cjs",
});
