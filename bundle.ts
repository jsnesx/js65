
import * as path from "std/path/mod.ts";
import * as esbuild from "esbuild";
import { denoPlugins } from "esbuild_deno_loader";

function getConfigPath(importMeta: ImportMeta): string {
  return path.resolve(path.dirname(path.fromFileUrl(importMeta.url)), "deno.jsonc");
}
  
const cfgPath = getConfigPath(import.meta);

await esbuild.build({
  plugins: [...denoPlugins({configPath: cfgPath})],
  entryPoints: [
    'src/cli.ts'
  ],
  bundle: true,
  minify: true,
  platform: "neutral",
  target: ["es2020"],
  outfile: 'build/cli.js',
});
esbuild.stop()
