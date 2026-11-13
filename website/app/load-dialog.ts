import {samples} from './samples.ts';

interface SavedWorkspace {
  name: string;
  files: [string, string][];
}

const storageKey = 'js65.saved-workspaces';

function readSaved(): SavedWorkspace[] {
  const saved: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]');
  if (!Array.isArray(saved) || !saved.every(entry =>
    entry && typeof entry.name === 'string' && entry.name.trim() &&
    Array.isArray(entry.files) && entry.files.every((file: unknown) =>
      Array.isArray(file) && file.length === 2 &&
      typeof file[0] === 'string' && file[0].startsWith('/workspace/') &&
      typeof file[1] === 'string') &&
    entry.files.some((file: [string, string]) => file[0] === '/workspace/main.s'))) {
    throw new Error('Invalid saved files');
  }
  return saved;
}

export function setupLoadDialog(root: HTMLElement,
  currentFiles: () => Map<string, string>, loadFiles: (files: Map<string, string>) => void): void {
  const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const dialog = get<HTMLDialogElement>('load-dialog');
  const savedList = get('saved-workspaces');
  const status = get('load-status');
  const name = get<HTMLInputElement>('save-name');
  const save = get<HTMLButtonElement>('save-workspace');

  function load(name: string, files: Map<string, string>): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = name;
    button.addEventListener('click', () => {
      dialog.close();
      loadFiles(files);
    });
    return button;
  }

  function renderSaved(): void {
    savedList.replaceChildren();
    try {
      const saved = readSaved();
      save.disabled = false;
      if (!saved.length) savedList.textContent = 'No saved files yet.';
      for (const entry of saved) savedList.append(load(entry.name, new Map(entry.files)));
    } catch {
      save.disabled = true;
      status.textContent = 'Browser storage could not be read. Samples are still available.';
    }
  }

  for (const sample of samples) get('samples').append(load(sample.name, sample.files));
  get('load').addEventListener('click', () => {
    status.textContent = '';
    renderSaved();
    dialog.showModal();
  });
  get('close-load').addEventListener('click', () => dialog.close());
  get<HTMLFormElement>('save-form').addEventListener('submit', event => {
    event.preventDefault();
    const title = name.value.trim();
    if (!title || save.disabled) return;
    try {
      const saved = readSaved();
      const entry = {name: title, files: [...currentFiles()]};
      const index = saved.findIndex(item => item.name === title);
      if (index < 0) saved.push(entry); else saved[index] = entry;
      localStorage.setItem(storageKey, JSON.stringify(saved));
      renderSaved();
      status.textContent = `Saved "${title}" in this browser.`;
    } catch {
      status.textContent = 'Could not save files in browser storage.';
    }
  });
}
