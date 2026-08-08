// SPDX-License-Identifier: MPL-2.0

// generates a version number from the git tag
// used by the build bot to take the current tag and apply it to all the builds.

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, renameSync } from 'fs';
import { join } from 'path';

const ROOT = import.meta.dirname;

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

function computeVersion(): string {
  try {
    const described = git(['describe', '--tags', '--long', '--match', 'v*']);
    const m = /^v(.+)-(\d+)-g([0-9a-f]+)$/.exec(described);
    if (!m) throw new Error(`unexpected \`git describe\` output: ${described}`);
    const [, tag, distance, hash] = m;
    let version = tag;
    if (distance !== '0') version += (tag.includes('-') ? '.' : '-') + `dev.${distance}`;
    if (distance !== '0') version += `+g${hash}`;
    return version;
  } catch {
    // No tag is reachable from HEAD (e.g. a shallow clone or a repo with no releases yet).
    const hash = git(['rev-parse', '--short', 'HEAD']);
    const count = git(['rev-list', '--count', 'HEAD']);
    return `0.0.0-dev.${count}+g${hash}`;
  }
}

// Write via a temp file + rename so concurrent invocations (e.g. the parallel
// `build` script) never leave a file half-written.
function writeAtomic(path: string, content: string) {
  const tmp = `${path}.tmp${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

// Edit the version field textually rather than JSON.parse + stringify, so we
// don't clobber the file's existing formatting (key order, spacing, etc).
function updatePackageJson(path: string, version: string) {
  const json = readFileSync(path, 'utf8');
  const updated = json.replace(/"version"\s*:\s*"[^"]*"/, `"version": "${version}"`);
  if (updated === json && !/"version"\s*:/.test(json)) {
    throw new Error(`${path}: no "version" field found to update`);
  }
  writeAtomic(path, updated);
}

function updateDirectoryBuildProps(path: string, version: string) {
  const xml = readFileSync(path, 'utf8');
  const updated = xml.replace(/<Version>[^<]*<\/Version>/, `<Version>${version}</Version>`);
  if (updated === xml && !xml.includes('<Version>')) {
    throw new Error(`${path}: no <Version> element found to update`);
  }
  writeAtomic(path, updated);
}

function updateVersionTs(path: string, version: string) {
  writeAtomic(path, `\
// SPDX-License-Identifier: MPL-2.0

// This file is auto generated as part of the build process
export const VERSION = ${JSON.stringify(version)};
`);
}

const version = computeVersion();
updatePackageJson(join(ROOT, 'package.json'), version);
updateDirectoryBuildProps(join(ROOT, 'integrations/dotnet/Directory.Build.props'), version);
updateVersionTs(join(ROOT, 'src/version.ts'), version);
process.stderr.write(`version: ${version}\n`);
