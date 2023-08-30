// deno-lint-ignore-file
import * as std from 'std';
import * as os from 'os';

import { sha1 } from './sha1.js'
import { Cli } from 'build/cli.js';

const cli = new Cli({
  fsResolve: resolve,
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

function resolve(path, filename) {
  return new Promise((resolve) => {
    resolve(abspath(path,filename));
  });
}

function abspath(path, filename) {
  if (!path)
    path = './';
  const f = filename === Cli.STDIN ? './' : filename;
  if (!path.endsWith('/'))
    path += '/';

  const [str, err] = os.realpath(path + f);
  if (err === 0) return str;
  throw new Error(std.strerror(err));
}

function readFileAsString(filename) {
  return new Promise((accept) => {
    const err = {errno: 0};
    const path = filename === Cli.STDIN ? Cli.STDIN : filename;
    // if (e != 0) throw new Error(std.strerror(e));
    // console.log(path);
    const f = path === Cli.STDIN ? std.in : std.open(path, 'r', err);
    // console.log(std.strerror(err.errno));
    if (err.errno != 0) throw new Error(std.strerror(err.errno));
    const str = f.readAsString();
    // console.log(str);
    accept(str);
  });
}

function readFileAsBuffer(filename) {
  return new Promise((accept) => {
    const err = {errno: 0};
    const f = filename === Cli.STDIN ? std.in : std.open(filename, 'rb', err);
    if (err.errno != 0) throw new Error(std.strerror(err.errno));
    f.seek(std.SEEK_END);
    const len = f.tell();
    f.seek(std.SEEK_SET);
    const bytes = new Uint8Array(len);
    f.read(bytes, 0, len);
    f.close();
    accept(bytes);
  });
}

function writeFileAsString(filename, data) {
  return new Promise((accept) => {
    const err = {errno: 0};
    const f = filename === Cli.STDOUT ? std.out : std.open(filename, 'w', err);
    if (err.errno != 0) throw new Error(std.strerror(err.errno));
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
    if (err.errno != 0) throw new Error(std.strerror(err.errno));
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

