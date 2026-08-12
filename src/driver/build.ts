
// SPDX-License-Identifier: MPL-2.0

import { Base64 } from '../base64.ts';
import { SourceError, type AssemblerMessage } from '../error.ts';
import { compile, deserializeObjectFile, findOutput, isGzip, type AssemblyInput,
         type CompileResult, type FileCallbacks, type Js65Options } from '../libassembler.ts';
import type { LintOptions, SymbolDefine } from '../options.ts';
import { dirOf, joinDir } from '../util.ts';
import type { Callbacks } from './fs.ts';
import { expandPathPatterns } from './glob.ts';
import { resolveProjectPath, type Js65Config, type Js65Project } from './project.ts';

/** Pseudo-paths the frontends recognize in place of a real file. */
export const STDIN = '//stdin';
export const STDOUT = '//stdout';

/** Where one build's artifacts go. An absent sidecar is simply not written. */
export interface OutputPaths {
  outfile: string;
  dbgfile?: string;
  mapfile?: string;
  depfile?: string;
}

/** Make doesn't accept windows style paths */
function escapeMakePath(path: string): string {
  return path.replace(/ /g, '\\ ');
}

export class BuildSession {
  // Keep a local cache of sources opened and compiled for diagnostic printing
  // later so we don't need to reload the files
  private readonly sources = new Map<string, string>();
  private readonly sourceLines = new Map<string, string[]>();

  // Resolved paths of every file this build actually read, for --create-dep. A Set
  // dedupes the header that gets included from a dozen places while keeping read
  // order, so the dependency file comes out the same on every run.
  private readonly deps = new Set<string>();

  constructor(readonly callbacks: Callbacks) {}

  readonly fileCallbacks: FileCallbacks = {
    readText: (path, filename) => this.readSource(path, filename),
    readBinary: (path, filename) => this.readBinary(path, filename),
  };

  reset() {
    this.sources.clear();
    this.sourceLines.clear();
    this.deps.clear();
  }

  private trackDep(path: string, filename: string) {
    if (filename === STDIN) return;
    this.deps.add(joinDir(path, filename));
  }

  // Load the file and keep the source code in our local cache for later.
  async readSource(path: string, filename: string): Promise<string> {
    const code = await this.callbacks.fsReadString(path, filename);
    this.trackDep(path, filename);
    // An include is recorded under the path it resolved to, not the one it was
    // written as, so cache it that way or a diagnostic in it finds nothing.
    this.cacheSource(joinDir(path, filename), code);
    return code;
  }

  async readBinary(path: string, filename: string): Promise<Uint8Array|string> {
    const data = await this.callbacks.fsReadBytes(path, filename);
    this.trackDep(path, filename);
    return data;
  }

  /**
   * Peak at the file as a binary input and check to see if its a gzip file or
   * a text file (skipping over the BOM if its there)
   */
  async readInput(filename: string): Promise<AssemblyInput> {
    let bytes = await this.readBinary("", filename);
    if (typeof bytes === "string") bytes = new Base64().decode(bytes);
    if (isGzip(bytes)) {
      return { type: 'module', module: await deserializeObjectFile(bytes, filename) };
    }
    // Frontends also strip the BOM, but it doesn't hurt to check it in this path too.
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) bytes = bytes.subarray(3);
    const code = new TextDecoder().decode(bytes);
    // No assembly source starts with `{` so error out if it didn't decompress earlier.
    if (code.trimStart().startsWith('{')) {
      throw new Error(`${filename}: not a valid object file`);
    }
    this.cacheSource(filename, code);
    return { type: 'source', code, name: filename };
  }

  private cacheSource(filename: string, code: string) {
    const key = joinDir('', filename);
    this.sources.set(key, code);
    this.sourceLines.delete(key);
  }

  /**
   * One line of a file this build read, by its 1-based line number, or undefined if
   * the file was never read or is shorter than that. Splitting is deferred until a
   * diagnostic actually asks, since most builds never print one.
   */
  sourceLine(file: string, line: number): string | undefined {
    const key = joinDir('', file);
    let lines = this.sourceLines.get(key);
    if (!lines) {
      const text = this.sources.get(key);
      if (text === undefined) return undefined;
      lines = text.split(/\r\n|\n|\r/);
      this.sourceLines.set(key, lines);
    }
    return lines[line - 1];
  }

  /** Everything this build read, in read order, for `--create-dep`. */
  dependencies(): string[] {
    return [...this.deps];
  }

  async writeOutputs(result: CompileResult, paths: OutputPaths): Promise<number> {
    // The linked ROM / first artifact goes to outfile for now
    const primary = result.outputs.find(o => o.type === 'binary' || o.type === 'object')
        ?? result.outputs[0];
    await this.callbacks.fsWriteBytes("", paths.outfile, primary.data);

    // A linker config can send segments to files of their own. Their names
    // come from the config verbatim, so `%O` still has to be filled in.
    for (const extra of result.outputs) {
      if (extra === primary || extra.type !== 'binary') continue;
      await this.callbacks.fsWriteBytes(
          "", extra.name.replace(/%O/g, paths.outfile), extra.data);
    }

    // Write debug info if requested
    const debug = findOutput(result, 'debug');
    if (paths.dbgfile && debug) {
      await this.callbacks.fsWriteBytes("", paths.dbgfile, debug.data);
    }

    // Write the linker map if requested
    const map = findOutput(result, 'map');
    if (paths.mapfile && map) {
      await this.callbacks.fsWriteBytes("", paths.mapfile, map.data);
    }

    // Write the make dependency file last, once the build has actually succeeded.
    if (paths.depfile) {
      await this.writeDepFile(paths.depfile, paths.outfile);
    }
    return primary.data.length;
  }

  /**
   * Write the makefile targets for `--create-dep` which look like this
   *
   *     out.nes:	main.s inc/header.inc chr/tiles.chr
   *
   *     main.s inc/header.inc chr/tiles.chr:
   */
  async writeDepFile(name: string, target: string) {
    const prereqs = [...this.deps].map(escapeMakePath).join(' ');
    const phony = prereqs ? `${prereqs}:\n\n` : '';
    const text = `${escapeMakePath(joinDir('', target))}:\t${prereqs}\n\n${phony}`;
    await this.callbacks.fsWriteBytes("", name, new TextEncoder().encode(text));
  }
}

/**
 * Command line settings that win over whatever `js65.json` says, applied to every
 * project the run selected. The path fields only make sense for a single project, which
 * the CLI checks before it gets here.
 */
export interface BuildOverrides {
  /** Appended to the project's own `.include` search path. */
  includePaths?: string[];
  /** Appended to the project's own `.incbin` search path. */
  binIncludePaths?: string[];
  /** Applied after the project's, so `-D NAME=x` wins over the file's value. */
  defines?: SymbolDefine[];
  features?: string[];
  lint?: LintOptions;
  outfile?: string;
  dbgfile?: string;
  mapfile?: string;
  depfile?: string;
}

/** How one project in a multi-project run turned out. */
export interface ProjectResult {
  name: string;
  success: boolean;
  /** Where the primary artifact went, or would have gone had it built. */
  outfile: string;
  /** Size of the primary artifact, absent when the project failed. */
  bytes?: number;
  errors: number;
  warnings: number;
}

export interface BuildResult {
  success: boolean;
  projects: ProjectResult[];
}

/** Where a `Builder` sends diagnostics and progress. Both default to nothing. */
export interface BuildReporter {
  /** Diagnostics from one project, in the order the compiler produced them. */
  messages?: (messages: AssemblerMessage[]) => void;
  /** One line of build progress, already formatted. */
  log?: (line: string) => void;
}

/**
 * Pick the projects a `js65 build` invocation names. No names means all of them, and an
 * unknown name is a usage error rather than a silent no-op.
 */
export function selectProjects(
    config: Js65Config, names: readonly string[]): Js65Project[] {
  if (!names.length) return [...config.projects];
  return names.map(name => {
    const project = config.projects.find(p => p.name === name);
    if (!project) {
      const known = config.projects.map(p => p.name).join(', ');
      throw new Error(
          `no project named "${name}" in ${config.projectFile}` +
          (known ? ` (known projects: ${known})` : ''));
    }
    return project;
  });
}

export class Builder {
  constructor(private readonly session: BuildSession,
              private readonly reporter: BuildReporter = {}) {}

  async build(config: Js65Config, projects: readonly Js65Project[],
              overrides: BuildOverrides = {}): Promise<BuildResult> {
    const results: ProjectResult[] = [];
    if (!projects.length) {
      this.log(`js65: no projects to build in ${config.projectFile}`);
      return {success: true, projects: results};
    }
    this.log(`js65: building ${count(projects.length, 'project')} from ` +
             `${config.projectFile}`);
    // The name column lines up, so a failure is easy to spot in a long run.
    const width = Math.max(...projects.map(p => p.name.length));
    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      const result = await this.buildOne(config, project, overrides);
      results.push(result);
      const status = result.success ? 'ok    ' : 'FAILED';
      const detail = result.success
          ? `${relativeTo(config.rootDir, result.outfile)} (${result.bytes} bytes)`
          : count(result.errors, 'error');
      this.log(`[${i + 1}/${projects.length}] ${project.name.padEnd(width)}  ` +
               `${status}  ${detail}`);
    }
    const failed = results.filter(r => !r.success).length;
    if (failed) {
      this.log(`js65: ${failed} of ${count(results.length, 'project')} failed`);
    }
    return {success: !failed, projects: results};
  }

  private async buildOne(config: Js65Config, project: Js65Project,
                         overrides: BuildOverrides): Promise<ProjectResult> {
    // Each project starts from a clean session: its own dependency list, and no source
    // text left over from the last one.
    this.session.reset();
    const outfile = overrides.outfile ?? project.output;
    try {
      const sources = await this.expand(config, project);
      const inputs: AssemblyInput[] = [];
      for (const source of sources) {
        inputs.push(await this.session.readInput(source));
      }
      const options = await this.options(config, project, overrides, sources);
      let baseRom: Uint8Array | undefined;
      if (project.baseRom) {
        const data = await this.session.readBinary("", project.baseRom);
        baseRom = typeof data === 'string' ? new Base64().decode(data) : data;
      }

      const result = await compile(inputs, options, this.session.fileCallbacks, baseRom);
      const errors = result.messages.filter(m => m.level === 'error').length;
      const warnings = result.messages.filter(m => m.level === 'warning').length;
      if (result.messages.length) this.reporter.messages?.(result.messages);
      if (!result.success) {
        return {name: project.name, success: false, outfile,
                errors: errors || 1, warnings};
      }

      const bytes = await this.session.writeOutputs(result, {
        outfile,
        dbgfile: overrides.dbgfile ?? project.dbgfile,
        mapfile: overrides.mapfile ?? project.mapfile,
        depfile: overrides.depfile,
      });
      return {name: project.name, success: true, outfile, bytes, errors, warnings};
    } catch (err) {
      // A missing source, an unreadable linker config or a pattern that matched nothing
      // fails this project only - the rest of the run still happens.
      this.reporter.messages?.([toMessage(project, err)]);
      return {name: project.name, success: false, outfile, errors: 1, warnings: 0};
    }
  }

  /** Absolute POSIX paths of the project's sources, in link order. */
  private async expand(config: Js65Config, project: Js65Project): Promise<string[]> {
    const matches =
        await expandPathPatterns(this.session.callbacks, config.rootDir, project.sourcePatterns);
    return matches.map(s => resolveProjectPath(config.rootDir, s));
  }

  private async options(config: Js65Config, project: Js65Project,
                        overrides: BuildOverrides,
                        sources: readonly string[]): Promise<Js65Options> {
    const debugLevel = project.debug ?? 0;
    const options: Js65Options = {
      // Seeded with each source's own directory, exactly like the flag path, so a
      // sibling `.include` resolves without listing every directory in the project file.
      includePaths: [
        ...sources.map(dirOf),
        ...project.includePaths,
        ...(overrides.includePaths ?? []),
      ],
      binIncludePaths: [
        ...project.binIncludePaths,
        ...(overrides.binIncludePaths ?? []),
      ],
      defines: [...project.defines, ...(overrides.defines ?? [])],
      features: [...project.features, ...(overrides.features ?? [])],
      target: project.target,
      outputFormat: project.format,
      lineContinuations: true,
      debugLevel,
      generateDebugInfo: debugLevel >= 0,
      generateMapFile: Boolean(overrides.mapfile ?? project.mapfile),
      lint: mergeLint(config.lint, overrides.lint),
    };
    // Read through the session so a config parse error gets a source snippet like any
    // other file would.
    if (project.linkerConfig !== undefined) {
      options.linkerConfig = project.linkerConfig;
      options.linkerConfigName = project.linkerConfigPath;
    } else if (project.linkerConfigPath) {
      options.linkerConfig = await this.session.readSource("", project.linkerConfigPath);
      options.linkerConfigName = project.linkerConfigPath;
    }
    return options;
  }

  private log(line: string) {
    this.reporter.log?.(line);
  }
}

/** `js65.json`'s lint block, with the command line's `--no-lint` / `-Wno-` on top. */
function mergeLint(fromFile?: LintOptions, fromFlags?: LintOptions): LintOptions {
  return {
    enabled: fromFlags?.enabled ?? fromFile?.enabled,
    rules: {...fromFile?.rules, ...fromFlags?.rules},
  };
}

function toMessage(project: Js65Project, err: unknown): AssemblerMessage {
  const message = err instanceof Error ? err.message : String(err);
  return {
    level: 'error',
    message: `${project.name}: ${message}`,
    source: err instanceof SourceError ? err.source : undefined,
  };
}

/** Shorten an absolute path for display when it sits under the project directory. */
function relativeTo(dir: string, path: string): string {
  return path.startsWith(`${dir}/`) ? path.substring(dir.length + 1) : path;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
