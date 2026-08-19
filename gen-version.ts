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

// The website links straight at this version's release assets, so it wants the
// bare tag without the dev-distance/hash suffix a between-tags build carries.
function updateHugoConfig(path: string, version: string) {
  const yaml = readFileSync(path, 'utf8');
  const updated = yaml.replace(/^(\s*version:\s*).*$/m, `$1${version}`);
  if (updated === yaml && !/^\s*version:\s*/m.test(yaml)) {
    throw new Error(`${path}: no \`version:\` key found to update`);
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

// The VS Code marketplace only accepts a strict `major.minor.patch`, so the
// extension gets the release version with any prerelease/build metadata dropped.
function marketplaceVersion(version: string): string {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`cannot derive a marketplace version from ${version}`);
  return `${m[1]}.${m[2]}.${m[3]}`;
}

// The tag itself, with any `dev.N+ghash` suffix a between-tags build appends
// stripped back off. That is the tag whose release assets actually exist.
function releaseVersion(version: string): string {
  return version.replace(/(?:[-.]dev\.\d+)?(?:\+g[0-9a-f]+)?$/, '');
}

const version = computeVersion();
updatePackageJson(join(ROOT, 'package.json'), version);
updatePackageJson(join(ROOT, 'lsp/client/package.json'), marketplaceVersion(version));
updateDirectoryBuildProps(join(ROOT, 'integrations/dotnet/Directory.Build.props'), version);
updateVersionTs(join(ROOT, 'src/version.ts'), version);
updateHugoConfig(join(ROOT, 'website/hugo.yaml'), releaseVersion(version));
process.stderr.write(`version: ${version}\n`);
