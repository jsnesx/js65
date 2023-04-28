
import * as esbuild from 'https://deno.land/x/esbuild@v0.17.12/mod.js'
import { denoPlugins } from "https://raw.githubusercontent.com/lucacasonato/esbuild_deno_loader/main/mod.ts";

await esbuild.build({
    plugins: [...denoPlugins()],
    entryPoints: [
        'cli.ts'
    ],
    bundle: true,
    // minify: true,
    platform: "neutral",
    target: ["es2020"],
    outfile: 'build/cli.js',
});
esbuild.stop()