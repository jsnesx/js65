import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import 'monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import {BuildService} from './build-service.ts';
import {registerLanguage} from './language.ts';
import {ListingView} from './listing-view.ts';
import {setupLoadDialog} from './load-dialog.ts';
import {samples} from './samples.ts';
import {DebuggerView, sourceAddresses} from './debugger.ts';
import {RuntimeClient} from './runtime-client.ts';
import {targets, simulatorTarget, registerTarget, type TargetDescriptor} from './targets.ts';
import {readDraft, saveDraft} from './draft.ts';
import type {ListingIndex, ListingRow} from '../../src/listing.ts';
import type {AssemblerMessage} from '../../src/error.ts';

const root = document.querySelector<HTMLElement>('#try-me')!;
const assets = new URL(root.dataset.assets!, location.href);
(globalThis as typeof globalThis & {MonacoEnvironment: unknown}).MonacoEnvironment = {
  getWorker: () => new Worker(new URL('editor-worker.js', assets), {type: 'module'}),
};
const language = registerLanguage(monaco);
const models = new Map([...readDraft(samples[0].files)].map(([file, text]) =>
  [file, monaco.editor.createModel(text, 'js65', monaco.Uri.from({scheme: 'file', path: file}))]));

const get = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
const status = root.querySelector<HTMLElement>('.try-status')!;
const fileTabs = get('files');
const plain = matchMedia('(pointer: coarse)').matches;
const fallback = get<HTMLTextAreaElement>('fallback');
let active = '/workspace/main.s';
const editor = monaco.editor.create(get('editor'), {
  model: models.get(active), automaticLayout: true, minimap: {enabled: false},
  fontSize: 14, scrollBeyondLastLine: false, accessibilitySupport: 'on',
  ariaLabel: 'Assembly source', glyphMargin: true,
});
const highlights = editor.createDecorationsCollection();
const viewStates = new Map<string, monaco.editor.ICodeEditorViewState>();
const service = new BuildService(new URL('compiler-worker.js', assets));
const listing = new ListingView(get('assembly-listing'), associate);
const diagnostics = root.querySelector<HTMLElement>('.try-diagnostics')!;
let workspaceVersion = 0;
let buildAttempt = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;
let disposed = false;
let replacing = false;
let target = simulatorTarget;
let artifact: {version: number; targetId: string; index: ListingIndex; image: unknown} | undefined;
let running = false;
let runtimeReady = false;
const addressBreakpoints = new Set<number>();
const sourceBreakpoints = new Map<string, {file: string; line: number}>();
const breakpointDecorations = editor.createDecorationsCollection();
const debug = new DebuggerView(root, row => associate(row));
const runtime = new RuntimeClient(assets, response => {
  if (response.error) { runtimeFailure(response.error); return; }
  runtimeReady = true;
  running = response.running;
  if (response.snapshot) debug.render(response.snapshot, running);
  if (!target.capabilities.reverse) {
    get<HTMLButtonElement>('back').disabled = true;
    get('back').title = 'This target does not support reverse stepping.';
  }
}, runtimeFailure);

function runtimeFailure(message: string): void {
  running = runtimeReady = false;
  runtime.dispose();
  controls(!!artifact);
  get('runtime-status').textContent = message;
  get('run').textContent = 'Run';
}

function controls(ready: boolean): void {
  for (const id of ['run', 'reset', 'step', 'source-breakpoint']) get<HTMLButtonElement>(id).disabled = !ready;
  get<HTMLButtonElement>('back').disabled = true;
  get<HTMLButtonElement>('nmi').disabled = !ready || !target.capabilities.interrupts;
  get<HTMLInputElement>('irq').disabled = !ready || !target.capabilities.interrupts;
  get('nmi').title = target.capabilities.interrupts ? '' : 'This target does not support interrupts.';
  get('screen').hidden = !target.capabilities.pixels;
  get('display-hint').textContent = target.capabilities.pixels ?
    'Focus the screen for keyboard input. Arrow keys use WASD.' : 'This target has no pixel display.';
}

function invalidateRuntime(): void {
  runtime.dispose(); running = runtimeReady = false; artifact = undefined;
  addressBreakpoints.clear();
  controls(false); debug.clear();
  get('run').textContent = 'Run';
  get('runtime-status').textContent = 'Source changed. Waiting for a successful build.';
  updateBreakpoints();
}

function loadRuntime(): void {
  if (!artifact || artifact.version !== workspaceVersion || artifact.targetId !== target.id) return;
  runtime.start(workspaceVersion, target.id, target.worker);
  runtime.send({kind: 'load', image: artifact.image});
  runtimeReady = true;
  updateBreakpoints();
}

function updateBreakpoints(): void {
  const addresses = new Set(addressBreakpoints);
  for (const {file, line} of sourceBreakpoints.values()) {
    for (const address of artifact ? sourceAddresses(artifact.index, file, line) : []) addresses.add(address);
  }
  runtime.send({kind: 'breakpoints', addresses: [...addresses]});
  get('breakpoints').textContent = [
    ...[...addressBreakpoints].map(a => `$${a.toString(16).padStart(4, '0')}`),
    ...[...sourceBreakpoints.values()].map(s => `${s.file}:${s.line}${artifact && sourceAddresses(artifact.index, s.file, s.line).length ? '' : ' (unmapped)'}`),
  ].join(', ') || 'No breakpoints.';
  breakpointDecorations.set([...sourceBreakpoints.values()].filter(s => s.file === active).map(s => ({
    range: new monaco.Range(s.line, 1, s.line, 1), options: {glyphMarginClassName: 'try-breakpoint'},
  })));
}

function switchFile(file: string): void {
  if (!models.has(file)) return;
  const state = editor.saveViewState();
  if (state) viewStates.set(active, state);
  active = file;
  for (const tab of fileTabs.querySelectorAll<HTMLButtonElement>('[role=tab]')) {
    const selected = tab.dataset.file === file;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected) {
      get('source-panel').setAttribute('aria-labelledby', tab.id);
      tab.scrollIntoView({block: 'nearest', inline: 'nearest'});
    }
  }
  highlights.clear();
  editor.setModel(models.get(file)!);
  const previous = viewStates.get(file);
  if (previous) editor.restoreViewState(previous);
  fallback.value = models.get(file)!.getValue();
  updateBreakpoints();
}

function renderFileTabs(): void {
  fileTabs.replaceChildren();
  for (const [index, file] of [...models.keys()].entries()) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.id = `file-tab-${index}`;
    tab.dataset.file = file;
    tab.textContent = file.slice('/workspace/'.length);
    tab.title = file;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', 'source-panel');
    tab.setAttribute('aria-selected', String(file === active));
    tab.tabIndex = file === active ? 0 : -1;
    if (file === active) get('source-panel').setAttribute('aria-labelledby', tab.id);
    tab.addEventListener('click', () => switchFile(file));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const files = [...models.keys()];
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? files.length - 1 :
        (index + (event.key === 'ArrowRight' ? 1 : files.length - 1)) % files.length;
      switchFile(files[next]);
      (fileTabs.children[next] as HTMLButtonElement).focus();
    });
    fileTabs.append(tab);
  }
  const add = document.createElement('button');
  add.type = 'button';
  add.textContent = '+ New File';
  add.setAttribute('aria-label', 'New File');
  add.setAttribute('aria-haspopup', 'dialog');
  add.setAttribute('aria-controls', 'new-file-dialog');
  add.addEventListener('click', () => {
    get<HTMLFormElement>('new-file-form').reset();
    get('new-file-error').textContent = '';
    get<HTMLDialogElement>('new-file-dialog').showModal();
  });
  fileTabs.append(add);
}

function associate(row?: Pick<ListingRow, 'source'>, reveal = false): void {
  const source = row?.source;
  if (!source || !models.has(source.file)) { highlights.clear(); return; }
  if (reveal) switchFile(source.file);
  if (active !== source.file) { highlights.clear(); return; }
  highlights.set([{range: new monaco.Range(source.line, 1, source.line, 1),
    options: {isWholeLine: true, className: 'try-highlight'}}]);
  if (reveal) {
    editor.revealLineInCenter(source.line);
    editor.setPosition({lineNumber: source.line, column: source.column + 1});
    if (plain) {
      const model = models.get(active)!;
      const start = model.getOffsetAt({lineNumber: source.line, column: 1});
      fallback.focus();
      fallback.setSelectionRange(start, start + model.getLineLength(source.line));
    } else editor.focus();
  }
}

function invalidate(): void {
  workspaceVersion++;
  buildAttempt++;
  service.cancel();
  invalidateRuntime();
  if (!saveDraft(new Map([...models].map(([file, model]) => [file, model.getValue()])), target.id)) {
    get('runtime-status').textContent += ' Browser draft storage is unavailable.';
  }
  clearTimeout(debounce);
  debounce = setTimeout(() => void assemble(), 350);
}

function showDiagnostics(messages: AssemblerMessage[]): void {
  diagnostics.replaceChildren();
  const counts = {error: 0, warning: 0, info: 0};
  for (const message of messages) counts[message.level]++;
  for (const level of ['error', 'warning', 'info'] as const) {
    get(`${level}-count`).textContent = String(counts[level]);
  }
  get('output-tab').setAttribute('aria-label',
    `Output (${counts.error} errors, ${counts.warning} warnings, ${counts.info} info)`);
  if (!messages.length) diagnostics.textContent = 'Compiler returned: 0';
  for (const [file, model] of models) {
    monaco.editor.setModelMarkers(model, 'compiler', messages.filter(m => m.source?.file === file).map(m => {
      const source = m.source!;
      return {message: m.message, severity: m.level === 'error' ? monaco.MarkerSeverity.Error :
        m.level === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        startLineNumber: source.line, startColumn: source.column + 1,
        endLineNumber: source.endLine ?? source.line,
        endColumn: (source.endColumn ?? source.column + 1) + 1};
    }));
  }
  for (const message of messages) {
    const element = document.createElement('span');
    const source = message.source;
    const location = source?.file && source.line > 0 ?
      `${source.file}:${source.line}:${source.column + 1}` : 'js65';
    const label = message.level === 'info' ? 'note' : message.level;
    const code = message.code ? ` [${message.code}]` : '';
    element.className = 'try-message';
    element.textContent = `${location}: ${label}: ${message.message}${code}`;
    if (source && models.has(source.file)) {
      element.tabIndex = 0;
      element.setAttribute('role', 'link');
      element.title = location;
      element.addEventListener('pointerenter', () => associate(message));
      element.addEventListener('pointerleave', () => associate());
      element.addEventListener('focus', () => associate(message));
      element.addEventListener('blur', () => associate());
      element.addEventListener('click', () => associate(message, true));
      element.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault();
          associate(message, true);
        }
      });
    }
    diagnostics.append(element);
  }
}

function showCompilationFailure(failed: boolean): void {
  get('assembly-listing').hidden = failed;
  get('display-content').hidden = failed;
  for (const message of root.querySelectorAll<HTMLElement>('.try-failure')) message.hidden = !failed;
}

async function assemble(): Promise<void> {
  clearTimeout(debounce);
  invalidateRuntime();
  const attempt = ++buildAttempt;
  const version = workspaceVersion;
  try {
    const {identity, result} = await service.build(new Map([...models].map(([file, model]) =>
      [file, model.getValue()])), version, target);
    if (disposed || attempt !== buildAttempt || identity.workspaceVersion !== workspaceVersion || identity.targetId !== target.id) return;
    listing.clear();
    showDiagnostics(result.messages);
    if (!result.success) {
      status.textContent = 'Assembly failed.';
      showCompilationFailure(true);
      return;
    }
    const text = new TextDecoder().decode(result.outputs.find(o => o.type === 'listing')?.data);
    const index = JSON.parse(new TextDecoder().decode(
      result.outputs.find(o => o.type === 'listing-index')?.data)) as ListingIndex;
    listing.render(text, index);
    showCompilationFailure(false);
    status.textContent = '';
    try {
      artifact = {version, targetId: target.id, index, image: target.load(index)};
      debug.artifact(index);
      controls(true);
      loadRuntime();
    } catch (error) {
      get('runtime-status').textContent = error instanceof Error ? error.message : String(error);
      showDiagnostics([...result.messages, {level: 'error', message: get('runtime-status').textContent!}]);
    }
  } catch (error) {
    if (disposed || attempt !== buildAttempt || version !== workspaceVersion) return;
    status.textContent = error instanceof Error ? error.message : String(error);
    showDiagnostics([{level: 'error', message: status.textContent}]);
    listing.clear();
    showCompilationFailure(true);
  }
}

function watchModel(model: monaco.editor.ITextModel): monaco.IDisposable {
  return model.onDidChangeContent(() => {
    if (replacing) return;
    if (model === models.get(active)) fallback.value = model.getValue();
    invalidate();
  });
}
const modelSubscriptions = new Map([...models].map(([file, model]) => [file, watchModel(model)]));
const selectionSubscription = editor.onDidChangeCursorSelection(event => listing.select(active, event.selection));
function toggleSourceBreakpoint(line = editor.getPosition()?.lineNumber ?? 1): void {
  const key = `${active}:${line}`;
  if (sourceBreakpoints.has(key)) sourceBreakpoints.delete(key);
  else sourceBreakpoints.set(key, {file: active, line});
  updateBreakpoints();
}
const mouseSubscription = editor.onMouseDown(event => {
  if (event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN && event.target.position) {
    toggleSourceBreakpoint(event.target.position.lineNumber);
  }
});
editor.addAction({id: 'toggle-breakpoint', label: 'Toggle source breakpoint', keybindings: [monaco.KeyCode.F9],
  run: () => toggleSourceBreakpoint()});
get('source-breakpoint').addEventListener('click', () => toggleSourceBreakpoint(plain ?
  models.get(active)!.getPositionAt(fallback.selectionStart).lineNumber : undefined));
get('breakpoint-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = get<HTMLInputElement>('breakpoint-address');
  if (!/^[0-9a-f]{1,4}$/i.test(input.value)) return;
  const address = parseInt(input.value, 16);
  if (addressBreakpoints.has(address)) addressBreakpoints.delete(address); else addressBreakpoints.add(address);
  updateBreakpoints();
});
get('run').addEventListener('click', () => {
  if (!artifact) return;
  if (!runtimeReady) loadRuntime();
  const speed = Number(get<HTMLSelectElement>('speed').value);
  const budget = Math.max(1, Math.min(10000000, Number(get<HTMLInputElement>('budget').value) || 1000000));
  runtime.send(running ? {kind: 'pause'} : {kind: 'run', speed, budget});
  running = !running;
  get('run').textContent = running ? 'Pause' : 'Run';
});
for (const [id, kind] of [['reset', 'reset'], ['step', 'step'], ['back', 'back'], ['nmi', 'nmi']] as const) {
  get(id).addEventListener('click', () => {
    if (!runtimeReady) loadRuntime();
    runtime.send({kind});
  });
}
get<HTMLInputElement>('irq').addEventListener('change', event => runtime.send({kind: 'irq',
  value: (event.target as HTMLInputElement).checked}));
get('screen').addEventListener('keydown', event => {
  if (get('display').hidden || event.ctrlKey || event.metaKey || event.altKey || document.activeElement !== get('screen')) return;
  const key = ({ArrowUp: 'w', ArrowDown: 's', ArrowLeft: 'a', ArrowRight: 'd'} as Record<string, string>)[event.key] ?? event.key;
  if (key.length !== 1 || key.charCodeAt(0) < 32 || key.charCodeAt(0) > 126) return;
  event.preventDefault(); runtime.send({kind: 'input', value: key.charCodeAt(0)});
});
const targetSelect = get<HTMLSelectElement>('target');
for (const descriptor of targets.values()) {
  if ([...targetSelect.options].some(option => option.value === descriptor.id)) continue;
  targetSelect.add(new Option(descriptor.name, descriptor.id));
}
targetSelect.addEventListener('change', () => {
  const next = targets.get(targetSelect.value);
  if (!next) return;
  target = next; sourceBreakpoints.clear(); invalidate();
});
export function registerPlaygroundTarget(descriptor: TargetDescriptor): () => void {
  const remove = registerTarget(descriptor);
  const option = new Option(descriptor.name, descriptor.id);
  targetSelect.add(option);
  return () => {
    remove(); option.remove();
    if (target.id === descriptor.id) {
      targetSelect.value = simulatorTarget.id;
      targetSelect.dispatchEvent(new Event('change'));
    }
  };
}
renderFileTabs();
fallback.addEventListener('input', () => {
  const start = fallback.selectionStart;
  const end = fallback.selectionEnd;
  models.get(active)!.setValue(fallback.value);
  fallback.setSelectionRange(start, end);
});
fallback.addEventListener('select', () => {
  const model = models.get(active)!;
  const start = model.getPositionAt(fallback.selectionStart);
  const end = model.getPositionAt(fallback.selectionEnd);
  listing.select(active, new monaco.Selection(start.lineNumber, start.column, end.lineNumber, end.column));
});
get('editor').hidden = plain;
fallback.hidden = !plain;
fallback.value = models.get(active)!.getValue();
const newFileDialog = get<HTMLDialogElement>('new-file-dialog');
get('cancel-new-file').addEventListener('click', () => newFileDialog.close());
get('new-file-form').addEventListener('submit', event => {
  event.preventDefault();
  const name = get<HTMLInputElement>('new-file-name').value.trim();
  const file = `/workspace/${name}`;
  const error = get('new-file-error');
  if (!name || /[\\\x00-\x1f\x7f]/.test(name) ||
      name.split('/').some(part => !part || part === '.' || part === '..')) {
    error.textContent = 'Enter a relative file name, such as example.inc.';
    return;
  }
  if (models.has(file)) {
    error.textContent = 'A file with that name already exists.';
    return;
  }
  const model = monaco.editor.createModel('', 'js65', monaco.Uri.from({scheme: 'file', path: file}));
  models.set(file, model);
  modelSubscriptions.set(file, watchModel(model));
  renderFileTabs();
  newFileDialog.close();
  switchFile(file);
  if (plain) fallback.focus();
  else editor.focus();
  invalidate();
});
setupLoadDialog(root, () => new Map([...models].map(([file, model]) => [file, model.getValue()])), files => {
  sourceBreakpoints.clear();
  replacing = true;
  highlights.clear();
  editor.setModel(null);
  for (const [file, model] of models) {
    if (files.has(file)) continue;
    modelSubscriptions.get(file)!.dispose();
    modelSubscriptions.delete(file);
    model.dispose();
    models.delete(file);
  }
  for (const [file, text] of files) {
    const existing = models.get(file);
    if (existing) existing.setValue(text);
    else {
      const model = monaco.editor.createModel(text, 'js65', monaco.Uri.from({scheme: 'file', path: file}));
      models.set(file, model);
      modelSubscriptions.set(file, watchModel(model));
    }
  }
  renderFileTabs();
  replacing = false;
  viewStates.clear();
  switchFile('/workspace/main.s');
  invalidate();
  void assemble();
});
const tabs = ['assembly-tab', 'display-tab', 'output-tab'].map(id => get<HTMLButtonElement>(id));
function selectTab(index: number): void {
  tabs.forEach((tab, i) => {
    tab.setAttribute('aria-selected', String(i === index));
    tab.tabIndex = i === index ? 0 : -1;
    get(tab.getAttribute('aria-controls')!).hidden = i !== index;
  });
}
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => selectTab(i));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      (i + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length;
    selectTab(index);
    tabs[index].focus();
  });
});
const observer = new MutationObserver(() => monaco.editor.setTheme(
  document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs'));
observer.observe(document.documentElement, {attributes: true, attributeFilter: ['class']});
monaco.editor.setTheme(document.documentElement.classList.contains('dark') ? 'vs-dark' : 'vs');
window.addEventListener('pagehide', () => {
  disposed = true;
  clearTimeout(debounce);
  service.cancel();
  runtime.dispose();
  listing.clear();
  observer.disconnect();
  selectionSubscription.dispose();
  mouseSubscription.dispose();
  for (const subscription of modelSubscriptions.values()) subscription.dispose();
  editor.dispose();
  for (const model of models.values()) model.dispose();
  language.dispose();
});
window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
void assemble();
