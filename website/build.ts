import {mkdir, copyFile} from 'node:fs/promises';

const outdir = 'website/static/try-me-assets';
await mkdir(outdir, {recursive: true});
for (const [entry, name] of [
  ['website/app/main.ts', 'app'],
  ['website/app/editor.worker.ts', 'editor-worker'],
  ['src/driver/entry-worker-browser.ts', 'compiler-worker'],
]) {
  const result = await Bun.build({entrypoints: [entry], outdir, target: 'browser',
    format: 'esm', minify: true, naming: `${name}.[ext]`, loader: {'.ttf': 'file'}});
  if (!result.success) throw new AggregateError(result.logs, `Failed to build ${name}`);
  for (const output of result.outputs) console.log(`${output.path}: ${output.size} bytes`);
}
await copyFile('website/app/workspace.css', `${outdir}/workspace.css`);
