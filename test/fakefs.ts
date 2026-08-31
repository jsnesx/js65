
// SPDX-License-Identifier: MPL-2.0

import type {Callbacks} from '../src/driver/fs.ts';

/** An basic, in-memory `Callbacks` for driver tests. */
export interface FakeFs {
  callbacks: Callbacks;
  /** Everything written, keyed by path. */
  written: Map<string, Uint8Array>;
  /** One written file, decoded as text. */
  text: (name: string) => string;
}

export function fakeFs(files: Record<string, string|Uint8Array> = {}): FakeFs {
  const written = new Map<string, Uint8Array>();
  const join = (dir: string, name: string) => dir && dir !== '.' ? `${dir}/${name}` : name;
  const find = (full: string) => files[full] ?? written.get(full);
  const names = () => [...Object.keys(files), ...written.keys()];
  const listDir = (dir: string): string[] => {
    const prefix = !dir || dir === '.' ? '' : `${dir}/`;
    const entries = new Set<string>();
    for (const full of names()) {
      if (!full.startsWith(prefix)) continue;
      const rest = full.substring(prefix.length);
      const slash = rest.indexOf('/');
      entries.add(slash < 0 ? rest : `${rest.substring(0, slash)}/`);
    }
    // A directory only exists here if something is under it, and the root always does.
    if (prefix.length && !entries.size) throw new Error(`no such directory: ${dir}`);
    return [...entries];
  };
  const callbacks: Callbacks = {
    fsReadString: (dir, name) => {
      const data = find(join(dir, name));
      if (data === undefined) throw new Error(`no such file: ${join(dir, name)}`);
      return typeof data === 'string' ? data : new TextDecoder().decode(data);
    },
    fsReadBytes: (dir, name) => {
      const data = find(join(dir, name));
      if (data === undefined) throw new Error(`no such file: ${join(dir, name)}`);
      return typeof data === 'string' ? new TextEncoder().encode(data) : data;
    },
    fsReadStdin: async () => new Uint8Array(0),
    fsWriteString: async (dir, name, data) => {
      written.set(join(dir, name), new TextEncoder().encode(data));
    },
    fsWriteBytes: async (dir, name, data) => { written.set(join(dir, name), data); },
    fsListDir: listDir,
    exit: () => {},
  };
  return {callbacks, written,
          text: (name: string) => new TextDecoder().decode(written.get(name))};
}
