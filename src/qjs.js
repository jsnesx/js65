import * as std from 'std';

import { sha1 } from './sha1.js'
import { Cli } from 'build/cli.js';

const cli = new Cli({
  fsReadString: readFileAsString,
  fsReadBytes: readFileAsBuffer,
  fsWriteString: writeFileAsString,
  fsWriteBytes: writeFileAsBytes,
  fsWalk: fsWalk,
  cryptoSha1: sha1,
  exit: std.exit,
  stdin: std.in,
  stdout: std.out,
});

function readFileAsString(filename) {
  return new Promise((accept) => {
    const err = {errno: 0};
    const f = filename === Cli.STDIN ? std.in : std.open(filename, 'r', err);
    if (err.errno != 0) return accept([undefined, new Error(std.strerror(err.errno))]);
    accept(f.readAsString());
  });
}

function readFileAsBuffer(filename) {
  return new Promise((accept) => {
    const err = {errno: 0};
    const f = filename === Cli.STDIN ? std.in : std.open(filename, 'rb', err);
    if (err.errno != 0) return accept([undefined, new Error(std.strerror(err.errno))]);
    f.seek(std.SEEK_END);
    const len = f.tell();
    f.seek(std.SEEK_SET);
    const bytes = new Uint8Array(len);
    f.read(bytes, 0, len);
    f.close();
    accept([bytes, undefined]);
  });
}

function writeFileAsString(filename, data) {
  return new Promise((accept) => {
    const err = {errno: 0};
    const f = filename === Cli.STDOUT ? std.out : std.open(filename, 'w', err);
    if (err.errno != 0) return accept(new Error(std.strerror(err.errno)));
    f.seek(std.SEEK_SET);
    f.puts(data);
    f.close();
    accept();
  });
}

function writeFileAsBytes(filename, data) {
  return new Promise((accept) => {
    const err = {errno: 0};
    const f = filename === Cli.STDOUT ? std.out : std.open(filename, 'wb', err);
    if (err.errno != 0) return accept(new Error(std.strerror(err.errno)));
    f.seek(std.SEEK_SET);
    f.write(data, 0, data.length);
    f.close();
    accept();
  });
}

async function fsWalk(path, action) {
  console.log(`walking through ${path}`);
  const {paths, err} = std.readdir(path)
  if (err) return false;
  for (const path in paths) {
    const {f, err} = std.stat(path);
    if (err) continue;
    if (f.mode == std.S_IFDIR) {
      if (fsWalk(path, action)) {
        return true;
      }
    } else if (f.mode == std.S_IFMT) {
      console.log(`calling ${path}`);
      if (await action(path)) {
        console.log(`action success ${path}`);
        return true;
      }
    }
  }
  return false;
}

(async () => await cli.run(scriptArgs.slice(1)))();

