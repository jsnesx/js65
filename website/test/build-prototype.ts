const result = await Bun.build({entrypoints: ['website/test/prototype.ts'], target: 'browser',
  format: 'esm', minify: true, outdir: 'build/website-prototype'});
if (!result.success) throw new AggregateError(result.logs);
