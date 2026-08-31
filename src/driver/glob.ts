// SPDX-License-Identifier: MPL-2.0

import type { FileCallbacks } from '../libassembler.ts';
import { joinDir } from '../util.ts';
import { parseEntry } from './fs.ts';

const META = /[*?]/;

/** Whether `pattern` contains any glob metacharacter, i.e. needs expanding. */
export function isGlob(pattern: string): boolean {
  return META.test(pattern);
}

/** Escape the characters that are regex-special but literal in a glob. */
function escapeLiteral(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/** Translate one path segment (no `/`) into regex source. */
function segmentSource(seg: string): string {
  let out = '';
  for (const ch of seg) {
    if (ch === '*') out += '[^/]*';
    else if (ch === '?') out += '[^/]';
    else out += escapeLiteral(ch);
  }
  return out;
}

/** Compile a glob into a RegExp anchored at both ends. Backslashes normalize to `/`. */
export function globToRegExp(pattern: string): RegExp {
  const segs = toPosixPattern(pattern).split('/');
  let src = '^';
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    const last = i === segs.length - 1;
    if (seg === '**') {
      if (last) {
        // A trailing `**` swallows the remaining path, however deep.
        src += '.*';
      } else {
        // Zero or more whole segments, separator included, so `a/**/b` matches `a/b`.
        src += '(?:[^/]+/)*';
        continue;
      }
    } else {
      src += segmentSource(seg);
      if (!last) src += '/';
    }
  }
  return new RegExp(`${src}$`);
}

/** Test one POSIX-separated path against a glob. */
export function matchGlob(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(toPosixPattern(path));
}

function toPosixPattern(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * The longest leading run of literal segments, i.e. the directory expansion can start
 * from. `src/**\/*.s` roots at `src`, so a pattern never walks a sibling tree.
 */
export function globRoot(pattern: string): string {
  const segs = toPosixPattern(pattern).split('/');
  const lead: string[] = [];
  for (const seg of segs) {
    if (META.test(seg)) break;
    lead.push(seg);
  }
  // The final segment of a fully-literal pattern is the file itself, not a directory,
  // but callers only root globs, which always stop at a metacharacter segment first.
  if (lead.length === segs.length) lead.pop();
  return lead.join('/');
}

/** One directory listing, in `Callbacks.fsListDir` form. */
export type ListDir = (dir: string) => string[];

/**
 * The traversal behind every expansion here. It yields the directory it wants listed
 * and is sent back that directory's entries, or `null` if it could not be read.
 *
 * Entries whose name begins with `.` are skipped, keeping `**` out of `.git` and
 * friends; a dotfile can still be named by a literal (non-glob) source entry.
 */
export function* globWalk(rootDir: string, pattern: string):
    Generator<string, string[], string[] | null> {
  const posix = toPosixPattern(pattern);
  const re = globToRegExp(posix);
  const root = globRoot(posix);
  // Without a `**` the match depth is fixed, so recursion can stop at that depth rather
  // than reading the whole subtree.
  const segs = posix.split('/');
  const maxDepth = segs.includes('**') ? Infinity : segs.length;
  const out: string[] = [];

  function* visit(relDir: string, depth: number): Generator<string, void, string[] | null> {
    // absent or unreadable listing: a zero-match pattern is reported by the caller
    const entries = yield joinDir(rootDir, relDir) || '.';
    if (!entries) return;
    for (const entry of entries) {
      const {name, dir} = parseEntry(entry);
      if (name.startsWith('.')) continue;
      const rel = relDir ? `${relDir}/${name}` : name;
      if (dir) {
        if (depth + 1 < maxDepth) yield* visit(rel, depth + 1);
      } else if (re.test(rel)) {
        out.push(rel);
      }
    }
  }

  yield* visit(root, root ? root.split('/').length : 0);
  return out.sort();
}

/** Expand one pattern under `rootDir`, returning sorted matching paths relative to `rootDir`. */
export function expandGlob(
    list: ListDir, rootDir: string, pattern: string): string[] {
  const walk = globWalk(rootDir, pattern);
  let step = walk.next();
  while (!step.done) {
    let entries: string[] | null;
    try {
      entries = list(step.value);
    } catch {
      entries = null;
    }
    step = walk.next(entries);
  }
  return step.value;
}

/**
 * Expand a `sources` list. Literal entries keep their declared position; each pattern's
 * matches are sorted and spliced in place, so link order is stable and predictable.
 */
export function expandPathPatterns(
    list: ListDir, rootDir: string, patterns: readonly string[]): string[] {
  return mergeSources(patterns, patterns.map(
      p => isGlob(p) ? expandGlob(list, rootDir, p) : null));
}

/** Splice each pattern's expansion (`null` for a literal entry) back into the declared order. */
function mergeSources(
    patterns: readonly string[], expansions: ReadonlyArray<string[] | null>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (rel: string) => {
    // Overlapping patterns shouldn't assemble the same file twice - that would be a
    // duplicate-symbol error rather than a useful build.
    if (seen.has(rel)) return;
    seen.add(rel);
    out.push(rel);
  };
  for (let i = 0; i < patterns.length; i++) {
    const matches = expansions[i];
    if (!matches) {
      add(toPosixPattern(patterns[i]));
      continue;
    }
    if (!matches.length) {
      throw new Error(`no files matched source pattern "${patterns[i]}"`);
    }
    for (const rel of matches) add(rel);
  }
  return out;
}

export interface ResolvedGlob {
  base: string;
  path: string;
}

export function resolveGlob(
    cb: FileCallbacks, bases: readonly string[], pattern: string): ResolvedGlob[] {
  if (!isGlob(pattern)) return bases.map(base => ({base, path: toPosixPattern(pattern)}));
  if (!cb.listDir) {
    throw new Error(
        `"${pattern}" needs a glob, but this frontend provides no directory listing callback.`);
  }
  const list = cb.listDir;
  const out: ResolvedGlob[] = [];
  const seen = new Set<string>();
  for (const base of bases.length ? bases : ['']) {
    for (const path of expandGlob(list, base, pattern)) {
      // The same file reachable through two bases is still one file.
      const full = joinDir(base, path);
      if (seen.has(full)) continue;
      seen.add(full);
      out.push({base, path});
    }
  }
  return out;
}
