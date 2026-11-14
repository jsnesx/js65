const key = 'js65.playground-draft.v1';

export function readDraft(fallback: Map<string, string>): Map<string, string> {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (!data || data.version !== 1 || data.target !== 'sim' || !Array.isArray(data.files) ||
        !data.files.length || data.files.length > 128 || !data.files.every((pair: unknown) =>
          Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' &&
          pair[0].startsWith('/workspace/') && !/[\\\x00-\x1f\x7f]/.test(pair[0]) &&
          pair[0].slice('/workspace/'.length).split('/').every(part => !!part && part !== '.' && part !== '..') &&
          typeof pair[1] === 'string') || !data.files.some(([path]: [string, string]) => path === '/workspace/main.s')) return fallback;
    return new Map(data.files);
  } catch { return fallback; }
}

export function saveDraft(files: Map<string, string>, target: string): boolean {
  try {
    localStorage.setItem(key, JSON.stringify({version: 1, target, files: [...files]}));
    return true;
  } catch { return false; }
}
