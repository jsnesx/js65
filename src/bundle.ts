
import * as esbuild from 'https://deno.land/x/esbuild@v0.17.12/mod.js'
import { denoPlugins } from "https://deno.land/x/esbuild_deno_loader@0.8.1/mod.ts";

await esbuild.build({
    plugins: [...denoPlugins()],
    entryPoints: [
        'src/cli.ts'
    ],
    bundle: true,
    // minify: true,
    platform: "neutral",
    target: ["es2020"],
    outfile: 'build/cli.js',
});
esbuild.stop()