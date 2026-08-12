// SPDX-License-Identifier: MPL-2.0

/**
 * Loads the project file `js65.json` for the language server.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {expandPathPatternsSync} from '../../src/driver/glob.ts';
import {
  type Js65Config,
  parseProject,
  resolveProjectPath,
} from '../../src/driver/project.ts';

export {
  type Js65Config,
  type Js65Project,
  parseProject,
  projectsOwningFile,
  standaloneProject,
  toPosix,
} from '../../src/driver/project.ts';

export function findProjectFile(startFile: string, fsImpl = fs): string | undefined {
  let dir = path.isAbsolute(startFile) ? path.dirname(startFile) : path.resolve(path.dirname(startFile));
  while (true) {
    const candidate = path.join(dir, 'js65.json');
    try {
      if (fsImpl.statSync(candidate).isFile()) return candidate;
    } catch (_e) {
      // not present; keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function loadProject(projectFile: string, fsImpl = fs): Js65Config {
  let text: string;
  try {
    text = fsImpl.readFileSync(projectFile, 'utf8') as string;
  } catch (err) {
    throw new Error(`could not read ${projectFile}: ${errText(err)}`);
  }
  const config = parseProject(projectFile, text);
  const listDir = (dir: string) => readDirEntries(fsImpl, dir);
  for (const project of config.projects) {
    let expanded: string[];
    try {
      expanded = expandPathPatternsSync(listDir, config.rootDir, project.sourcePatterns);
    } catch (err) {
      throw new Error(`${config.projectFile}: ${project.name}: ${errText(err)}`);
    }
    project.sources = expanded.map(s => resolveProjectPath(config.rootDir, s));
    if (project.linkerConfigPath) {
      try {
        project.linkerConfig = fsImpl.readFileSync(project.linkerConfigPath, 'utf8') as string;
      } catch (err) {
        throw new Error(`${config.projectFile}: could not read linkerConfig ` +
                        `${project.linkerConfigPath}: ${errText(err)}`);
      }
    }
  }
  return config;
}

/** One directory in `Callbacks.fsListDir` form: bare names, trailing `/` on a dir. */
function readDirEntries(fsImpl: typeof fs, dir: string): string[] {
  return fsImpl.readdirSync(dir, {withFileTypes: true})
      .map(e => e.isDirectory() ? `${e.name}/` : e.name);
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
