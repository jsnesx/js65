#!/usr/bin/env node
import { main } from '../../dist/integrations/node.js';
main(process.argv.slice(2)).then(
  () => process.exit(process.exitCode ?? 0),
  () => process.exit(1),   // run() already printed the diagnostic
);
