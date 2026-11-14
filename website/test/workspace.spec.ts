import {afterAll, afterEach, beforeAll, beforeEach, setDefaultTimeout, test} from 'bun:test';
import {chromium, expect, type Browser, type Page} from '@playwright/test';
import {server} from './serve.ts';

setDefaultTimeout(30000);

let browser: Browser;
let page: Page;

async function fillSource(text: string): Promise<void> {
  const fallback = page.locator('#fallback');
  if (await fallback.isVisible()) await fallback.fill(text);
  else {
    await page.locator('.view-lines').click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(text);
  }
}

beforeAll(async () => {
  browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--disable-gpu']});
});

beforeEach(async () => {
  page = await browser.newPage({baseURL: 'http://127.0.0.1:4173/js65/'});
});

afterEach(async () => {
  await page?.context().close();
});

afterAll(async () => {
  try { await browser?.close(); }
  finally { server.close(); }
});

test('run, address break, inspect pixels, rewind, and reset', async () => {
  await page.goto('explore/');
  await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#breakpoint-address').fill('0602');
  await page.locator('#breakpoint-form button').click();
  await page.locator('#run').click();
  await expect(page.locator('#runtime-status')).toContainText('breakpoint.');
  await expect(page.locator('#registers')).toContainText('PC $0602  A $01');
  await page.locator('#step').click();
  await expect(page.locator('#runtime-status')).toContainText('completed.');
  await expect(page.locator('#memory')).toContainText('$0200: 01');
  expect(await page.locator('#screen').evaluate(canvas => [...(canvas as HTMLCanvasElement)
    .getContext('2d')!.getImageData(0, 0, 1, 1).data])).toEqual([255, 255, 255, 255]);
  await page.locator('#back').click();
  await expect(page.locator('#memory')).toContainText('$0200: 00');
  await page.locator('#step').click();
  await expect(page.locator('#memory')).toContainText('$0200: 01');
  await page.locator('#reset').click();
  await expect(page.locator('#registers')).toContainText('PC $0600');
  await expect(page.locator('#registers')).toContainText('Cycles 7');
  await expect(page.locator('#back')).toBeDisabled();
});

test('execution survives tabs, keyboard requires visible focus, and edits stop it', async () => {
  await page.goto('explore/');
  await expect(page.locator('#run')).toBeEnabled();
  await fillSource('.org $600\nloop: lda $ff\nsta $200\njmp loop\n');
  await expect(page.locator('#assembly')).toContainText('lda $ff');
  await page.locator('#speed').selectOption('1000');
  await page.locator('#run').click();
  await page.locator('#screen').focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#memory')).toContainText('$0200: 77');
  await page.getByRole('tab', {name: 'Assembly', exact: true}).click();
  await page.keyboard.press('b');
  await expect(page.locator('#run')).toHaveText('Pause');
  await page.getByRole('tab', {name: 'Display', exact: true}).click();
  await page.locator('#run').click();
  await expect(page.locator('#runtime-status')).toContainText('paused.');
  await expect(page.locator('#memory')).toContainText('$0200: 77');
  await page.locator('#run').click();
  await fillSource('.org $600\nlda missing\n');
  await expect(page.locator('.try-status')).toHaveText('Assembly failed.');
  await expect(page.locator('#run')).toBeDisabled();
  await expect(page.locator('#back')).toBeDisabled();
  await expect(page.locator('#registers')).toBeEmpty();
});

test('source breakpoints, budget, input replay, and automatic draft recovery', async () => {
  await page.goto('explore/');
  await expect(page.locator('#run')).toBeEnabled();
  await fillSource('.org $600\nloop: lda $ff\nsta $200\njmp loop\n');
  await expect(page.locator('#assembly')).toContainText('lda $ff');
  await page.locator('#screen').focus(); await page.keyboard.press('a');
  await page.locator('#step').click();
  await expect(page.locator('#registers')).toContainText('A $61');
  await page.locator('#back').click(); await page.locator('#step').click();
  await expect(page.locator('#registers')).toContainText('A $61');
  await page.locator('#budget').fill('6');
  await page.locator('#run').click();
  await expect(page.locator('#runtime-status')).toContainText('budget.');
  await page.reload();
  await expect(page.locator('#assembly')).toContainText('lda $ff');
  await expect(page.locator('#registers')).toContainText('A $00');
  await page.getByRole('tab', {name: 'Assembly', exact: true}).click();
  await page.locator('.try-row').filter({hasText: 'lda $ff'}).click();
  await page.locator('#source-breakpoint').click();
  await expect(page.locator('#breakpoints')).toContainText('/workspace/main.s:2');
  await page.locator('#run').click();
  await expect(page.locator('#runtime-status')).toContainText('breakpoint.');
  await expect(page.locator('#registers')).toContainText('PC $0600');
});

test('runtime worker crashes can restart without stale execution', async () => {
  await page.route('**/runtime-worker.js', route => route.fulfill({contentType: 'text/javascript',
    body: 'throw new Error("runtime fixture crash");'}));
  await page.goto('explore/');
  await expect(page.locator('#runtime-status')).toContainText('runtime fixture crash');
  await page.unroute('**/runtime-worker.js');
  await page.locator('#reset').click();
  await expect(page.locator('#registers')).toContainText('PC $0600');
  await page.locator('#run').click();
  await expect(page.locator('#runtime-status')).toContainText('completed.');
});

test('manual interrupt entry and rewind use the recorded event', async () => {
  await page.goto('explore/');
  await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#nmi').click();
  await page.locator('#step').click();
  await expect(page.locator('#registers')).toContainText('PC $FFF8');
  await expect(page.locator('#registers')).toContainText('Cycles 7');
  await page.locator('#step').click();
  await expect(page.locator('#registers')).toContainText('PC $0600');
  await page.locator('#back').click();
  await expect(page.locator('#registers')).toContainText('PC $FFF8');
  await page.locator('#back').click();
  await expect(page.locator('#registers')).toContainText('PC $0600');
  await page.locator('#step').click();
  await expect(page.locator('#registers')).toContainText('PC $FFF8');
});

test('internal second target invalidates mappings and capability controls', async () => {
  await page.goto('explore/');
  await expect(page.locator('#run')).toBeEnabled();
  await page.locator('#step').click();
  await expect(page.locator('#back')).toBeEnabled();
  await page.evaluate(async () => {
    const url = document.querySelector<HTMLScriptElement>('script[src*="try-me-assets/app.js"]')!.src;
    const api = await import(url);
    api.registerPlaygroundTarget({id: 'fixture', name: 'Internal fixture', compileTarget: 'js65-sim',
      worker: 'runtime-worker.js', capabilities: {reverse: false, interrupts: false, pixels: false},
      load: (index: {rows: {address?: number; bytes: number[]; authored: boolean}[]}) => {
        const memory = new Uint8Array(65536);
        for (const row of index.rows) if (row.authored && row.address != null) memory.set(row.bytes, row.address);
        memory[0xfffd] = 6;
        return {memory, entry: 0x600, completion: 0x605};
      }});
  });
  await page.locator('#target').selectOption('fixture');
  await expect(page.locator('#registers')).toContainText('PC $0600');
  await expect(page.locator('#back')).toBeDisabled();
  await expect(page.locator('#nmi')).toBeDisabled();
  await expect(page.locator('#display-hint')).toHaveText('This target has no pixel display.');
  await page.locator('#step').click();
  await expect(page.locator('#registers')).toContainText('PC $0602');
  await expect(page.locator('#back')).toBeDisabled();
  await page.locator('#target').selectOption('sim');
  await expect(page.locator('#registers')).toContainText('PC $0600');
  await expect(page.locator('#nmi')).toBeEnabled();
});

test('subpath assembly, source mapping, tabs, errors, and restart', async () => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.goto('explore/');
  await expect(page.getByRole('button', {name: 'Assemble', exact: true})).toHaveCount(0);
  await expect(page.locator('.try-status')).toHaveText('');
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(false);
  await expect(page.getByRole('tab', {name: 'Display', exact: true})).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel', {name: 'Display', exact: true})).toBeVisible();
  await page.getByRole('tab', {name: 'Assembly', exact: true}).click();
  const instruction = page.locator('.try-row').filter({hasText: 'lda #$01'});
  await expect(instruction).toHaveAttribute('title', /2 cycles/);
  await instruction.hover();
  await expect(page.locator('.try-highlight')).toHaveCount(1);
  await instruction.click();
  await expect(page.getByRole('link', {name: 'Download .lst'})).toHaveCount(0);
  await expect(page.locator('.try-status')).toBeHidden();
  await page.getByRole('tab', {name: 'Display', exact: true}).click();
  await expect(page.getByRole('tabpanel', {name: 'Display'})).toBeVisible();
  await page.getByRole('tab', {name: 'Display', exact: true}).press('ArrowLeft');
  await expect(page.getByRole('tabpanel', {name: 'Assembly'})).toBeVisible();
  await expect(instruction).toBeVisible();
  await fillSource('.org $600\n.include "values.inc"\nlda #color\n.byte $ea\n');
  await expect(page.locator('.try-status')).toHaveText('');
  await expect(page.locator('.try-row').filter({hasText: '.byte $EA'})).not.toHaveAttribute('title', /cycles/);
  await page.getByRole('tab', {name: 'values.inc', exact: true}).click();
  await fillSource('color = $07\n');
  await expect(page.locator('.try-row').filter({hasText: 'lda #$07'})).toBeVisible();
  await page.getByRole('tab', {name: 'main.s', exact: true}).click();
  await fillSource('.org $600\nlda missing\n');
  await expect(page.locator('.try-status')).toHaveText('Assembly failed.');
  await expect(page.locator('.try-row')).toHaveCount(0);
  for (const name of ['Assembly', 'Display']) {
    await page.getByRole('tab', {name, exact: true}).click();
    const failure = page.getByRole('tabpanel', {name, exact: true}).locator('.try-failure');
    await expect(failure).toBeVisible();
    await expect(failure).toHaveText('<Compilation failed>\n\n# For more information see the output window');
    await expect(failure.locator('.try-failure-error')).toHaveCSS('color', 'rgb(198, 40, 40)');
    await expect(failure.locator('.try-failure-comment')).toHaveCSS('color', 'rgb(40, 122, 58)');
  }
  await page.screenshot({path: 'build/playwright/compilation-failed.png'});
  await page.getByRole('button', {name: 'Load Project', exact: true}).click();
  await page.getByRole('button', {name: 'Basic example', exact: true}).click();
  await expect(page.locator('.try-status')).toHaveText('');
  await expect(page.locator('#display-content')).toBeVisible();
  await expect(page.locator('#display .try-failure')).toBeHidden();
  await page.getByRole('tab', {name: 'Assembly', exact: true}).click();
  await expect(page.locator('#assembly .try-failure')).toBeHidden();
  await expect(page.locator('.try-row').filter({hasText: 'lda #$01'})).toBeVisible();
  expect(errors).toEqual([]);
});

test('stuck builds terminate and newest revision wins', async () => {
  await page.goto('explore/');
  await expect(page.locator('.try-status')).toHaveText('');
  await page.getByRole('tab', {name: 'Assembly', exact: true}).click();
  await fillSource('.org $600\n.repeat 100000000\nnop\n.endrepeat\n');
  await page.waitForRequest('**/compiler-worker.js');
  await fillSource('.org $600\nlda #9\n');
  await expect(page.locator('.try-row').filter({hasText: 'lda #$09'})).toBeVisible();
  await expect(page.locator('.try-status')).toHaveText('');
});

test('output counts messages and links diagnostics to source', async () => {
  await page.goto('explore/');
  await expect(page.locator('.try-status')).toHaveText('');
  const outputTab = page.getByRole('tab', {name: /^Output/});
  await expect(outputTab).toHaveText('Output (0/0/0)');
  await expect(outputTab).toHaveAccessibleName('Output (0 errors, 0 warnings, 0 info)');
  await expect(outputTab.locator('#error-count')).toHaveCSS('color', 'rgb(255, 77, 77)');
  await expect(outputTab.locator('#warning-count')).toHaveCSS('color', 'rgb(255, 223, 0)');
  await expect(outputTab.locator('#info-count')).toHaveCSS('color', 'rgb(255, 255, 255)');
  await outputTab.click();
  const output = page.getByRole('tabpanel', {name: /^Output/});
  await expect(output).toHaveText('Compiler returned: 0');
  await expect(page.getByRole('tabpanel', {name: 'Assembly', exact: true})).toBeHidden();
  await page.getByRole('tab', {name: 'values.inc', exact: true}).click();
  await fillSource('.warning "Check value"\n.out "Ready"\ncolor = $01\n');
  await expect(outputTab).toHaveText('Output (0/1/1)');
  await expect(outputTab).toHaveAccessibleName('Output (0 errors, 1 warnings, 1 info)');
  await expect(output.getByRole('link', {name: '/workspace/values.inc:2:1: note: Ready', exact: true})).toBeVisible();
  const warning = output.getByRole('link', {name: '/workspace/values.inc:1:1: warning: Check value', exact: true});
  await expect(warning).toHaveCSS('border-width', '0px');
  await expect(warning).toHaveAttribute('title', '/workspace/values.inc:1:1');
  await warning.hover();
  await expect(page.locator('.try-highlight')).toHaveCount(1);
  await outputTab.hover();
  await expect(page.locator('.try-highlight')).toHaveCount(0);
  await warning.focus();
  await expect(page.locator('.try-highlight')).toHaveCount(1);
  await page.getByRole('tab', {name: 'main.s', exact: true}).click();
  await warning.click();
  await expect(page.getByRole('tab', {name: 'values.inc', exact: true})).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', {name: 'Assembly source', exact: true})).toBeFocused();
  await page.getByRole('tab', {name: 'main.s', exact: true}).click();
  await warning.press('Enter');
  await expect(page.getByRole('tab', {name: 'values.inc', exact: true})).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', {name: 'Assembly source', exact: true})).toBeFocused();
  await fillSource('  .error "Invalid value"\ncolor = $01\n');
  await expect(page.locator('.try-status')).toHaveText('Assembly failed.');
  await expect(outputTab).toHaveText('Output (1/0/0)');
  await expect(output.getByRole('link', {name: '/workspace/values.inc:1:3: error: Invalid value', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Load Project', exact: true}).click();
  await page.getByRole('button', {name: 'Basic example', exact: true}).click();
  await expect(page.locator('.try-status')).toHaveText('');
  await expect(outputTab).toHaveText('Output (0/0/0)');
  await expect(output).toHaveText('Compiler returned: 0');
});

test('unresponsive worker times out and can restart', async () => {
  await page.route('**/compiler-worker.js', route => route.fulfill({
    contentType: 'text/javascript', body: 'for (;;) {}',
  }));
  await page.goto('explore/');
  await expect(page.locator('.try-status')).toContainText('Build timed out', {timeout: 15000});
  await expect(page.locator('#display .try-failure')).toBeVisible();
  await page.getByRole('tab', {name: 'Output (1 errors, 0 warnings, 0 info)', exact: true}).click();
  await expect(page.locator('.try-diagnostics')).toContainText('Build timed out');
  await page.unroute('**/compiler-worker.js');
  await fillSource('.org $600\nlda #1\n');
  await page.getByRole('tab', {name: 'Assembly', exact: true}).click();
  await expect(page.locator('.try-row').filter({hasText: 'lda #$01'})).toBeVisible();
  await expect(page.locator('#assembly .try-failure')).toBeHidden();
});

test('compilation keeps previous results until their replacement arrives', async () => {
  await page.goto('explore/');
  await expect(page.locator('.try-status')).toHaveText('');
  const outputTab = page.getByRole('tab', {name: /^Output/});
  await fillSource('.org $600\n.warning "Previous result"\nlda #3\n');
  await outputTab.click();
  await expect(page.getByRole('link', {name: '/workspace/main.s:2:1: warning: Previous result', exact: true})).toBeVisible();
  for (const load of [false, true]) {
    let release!: () => void;
    let requested!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { requested = resolve; });
    await page.route('**/compiler-worker.js', async route => {
      requested();
      await gate;
      await route.continue();
    });
    const previousListing = await page.locator('#assembly').textContent();
    const previousOutput = await page.locator('.try-diagnostics').textContent();
    if (load) {
      await page.getByRole('button', {name: 'Load Project', exact: true}).click();
      await page.getByRole('button', {name: 'Basic example', exact: true}).click();
    }
    else {
      await fillSource('.org $600\n.warning "Next result"\nlda #9\n');
    }
    await started;
    await expect(page.locator('.try-status')).toBeEmpty();
    await expect(page.locator('#assembly')).toHaveText(previousListing!);
    await expect(page.locator('.try-diagnostics')).toHaveText(previousOutput!);
    await expect(page.locator('#screen')).toHaveCount(1);
    await expect(outputTab).toHaveText('Output (0/1/0)');
    release();
    if (load) {
      await expect(page.locator('.try-diagnostics')).toHaveText('Compiler returned: 0');
      await expect(page.locator('#assembly')).toContainText('lda #$01');
    } else {
      await expect(page.getByRole('link', {name: '/workspace/main.s:2:1: warning: Next result', exact: true})).toBeVisible();
      await expect(page.locator('#assembly')).toContainText('lda #$09');
    }
    await page.unroute('**/compiler-worker.js');
  }
});

test('load samples and saved browser files across reloads', async () => {
  await page.goto('explore/');
  await expect(page.locator('.try-status')).toHaveText('');
  await expect(page.getByRole('button', {name: 'Restore input'})).toHaveCount(0);
  const source = page.locator('#fallback');
  await fillSource('.org $600\n.include "values.inc"\nlda #color\n');
  await page.getByRole('tab', {name: 'values.inc', exact: true}).click();
  await fillSource('color = $09\n');
  const load = page.getByRole('button', {name: 'Load Project', exact: true});
  await load.click();
  const dialog = page.getByRole('dialog', {name: 'Load Project'});
  await expect(dialog).toContainText('No saved files yet.');
  await dialog.getByRole('textbox', {name: 'Save current files as'}).fill('My program');
  await dialog.getByRole('button', {name: 'Save to browser'}).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved "My program" in this browser.');
  await page.setViewportSize({width: 390, height: 844});
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({path: 'build/playwright/load-dialog.png'});
  await dialog.getByRole('button', {name: 'Counter loop', exact: true}).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('tablist', {name: 'Source files'}).getByRole('tab')).toHaveCount(1);
  await expect(source).toHaveValue(/ldx #0/);
  await expect(page.locator('#assembly')).toContainText('stx $0200');
  await page.reload();
  await expect(page.locator('.try-status')).toHaveText('');
  await load.click();
  await dialog.getByRole('button', {name: 'My program', exact: true}).click();
  await expect(page.locator('#assembly')).toContainText('lda #$09');
  await page.getByRole('tab', {name: 'values.inc', exact: true}).click();
  await expect(source).toHaveValue('color = $09\n');
  await load.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(load).toBeFocused();
  await expect(source).toHaveValue('color = $09\n');
});

test('load keeps samples available when browser storage is unavailable', async () => {
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function(key: string) {
      if (key === 'js65.saved-workspaces') throw new Error('Storage blocked');
      return getItem.call(this, key);
    };
  });
  await page.goto('explore/');
  await expect(page.locator('.try-status')).toHaveText('');
  await page.getByRole('button', {name: 'Load Project', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: 'Load Project'});
  await expect(dialog.getByRole('status')).toContainText('Browser storage could not be read.');
  await expect(dialog.getByRole('button', {name: 'Save to browser'})).toBeDisabled();
  await dialog.getByRole('button', {name: 'Counter loop', exact: true}).click();
  await expect(page.locator('#assembly')).toContainText('stx $0200');
});

test('error underline covers the complete operand', async () => {
  await page.goto('explore/');
  await expect(page.locator('.try-status')).toHaveText('');
  await fillSource('.org $600\nlda asdf\n');
  await expect(page.locator('.try-status')).toHaveText('Assembly failed.');
  const underline = page.locator('.squiggly-error');
  await expect(underline).toHaveCount(1);
  const wordBounds = await page.locator('.view-line').filter({hasText: 'asdf'}).evaluate(line => {
    const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const start = node.textContent!.indexOf('asdf');
      if (start < 0) continue;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + 4);
      const bounds = range.getBoundingClientRect();
      return {x: bounds.x, width: bounds.width};
    }
    throw new Error('Operand text was not rendered');
  });
  const errorBounds = await underline.boundingBox();
  expect(wordBounds).not.toBeNull();
  expect(errorBounds).not.toBeNull();
  expect(Math.abs(errorBounds!.x - wordBounds!.x)).toBeLessThanOrEqual(1);
  expect(Math.abs(errorBounds!.width - wordBounds!.width)).toBeLessThanOrEqual(1);
});

test('narrow layout and keyboard tabs', async () => {
  await page.setViewportSize({width: 390, height: 844});
  await page.goto('explore/');
  await expect(page.locator('.try-status')).toHaveText('');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('tab', {name: 'Assembly', exact: true}).focus();
  await page.keyboard.press('End');
  await expect(page.getByRole('tab', {name: /^Output/})).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', {name: 'Assembly', exact: true})).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', {name: /^Output/})).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', {name: 'Display', exact: true})).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('tab', {name: 'Assembly', exact: true})).toBeFocused();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({path: 'build/playwright/narrow.png', fullPage: true});
});

test('source tabs scroll and support keyboard file switching', async () => {
  await page.setViewportSize({width: 390, height: 844});
  await page.addInitScript(() => {
    localStorage.setItem('js65.saved-workspaces', JSON.stringify([{name: 'Many files', files: [
      ['/workspace/main.s', '.org $600\nlda #1\n'],
      ...Array.from({length: 8}, (_, i) => [`/workspace/long-file-name-${i}.inc`, `value = ${i}\n`]),
    ]}]));
  });
  await page.goto('explore/');
  await page.getByRole('button', {name: 'Load Project', exact: true}).click();
  await page.getByRole('button', {name: 'Many files', exact: true}).click();
  const tabs = page.getByRole('tablist', {name: 'Source files'});
  await expect(tabs.getByRole('tab')).toHaveCount(9);
  expect(await tabs.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const last = tabs.getByRole('tab', {name: 'long-file-name-7.inc', exact: true});
  await last.click();
  await expect(last).toHaveAttribute('aria-selected', 'true');
  const source = page.locator('#fallback');
  await expect(source).toHaveValue('value = 7\n');
  await fillSource('value = 9\n');
  await last.focus();
  await last.press('Home');
  const main = tabs.getByRole('tab', {name: 'main.s', exact: true});
  await expect(main).toBeFocused();
  await expect(main).toHaveAttribute('aria-selected', 'true');
  await expect(source).toHaveValue('.org $600\nlda #1\n');
  await main.press('ArrowLeft');
  await expect(last).toBeFocused();
  await expect(source).toHaveValue('value = 9\n');
  expect(await tabs.evaluate(element => element.scrollLeft > 0)).toBe(true);
});

test('new files validate names, assemble, and save with the project', async () => {
  await page.goto('explore/');
  await expect(page.locator('.try-status')).toHaveText('');
  await expect(page.getByRole('checkbox', {name: 'Plain text editor'})).toHaveCount(0);
  const add = page.getByRole('button', {name: 'New File', exact: true});
  const dialog = page.getByRole('dialog', {name: 'New File', exact: true});
  await add.click();
  const name = dialog.getByRole('textbox', {name: 'File name'});
  await expect(name).toBeFocused();
  await name.fill('main.s');
  await dialog.getByRole('button', {name: 'Create File'}).click();
  await expect(dialog.getByRole('alert')).toHaveText('A file with that name already exists.');
  await name.fill('../outside.inc');
  await dialog.getByRole('button', {name: 'Create File'}).click();
  await expect(dialog.getByRole('alert')).toContainText('Enter a relative file name');
  await dialog.getByRole('button', {name: 'Cancel'}).click();
  await expect(dialog).toBeHidden();
  await expect(add).toBeFocused();
  await add.click();
  await expect(name).toHaveValue('');
  await name.fill('math.inc');
  await name.press('Enter');
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('tab', {name: 'math.inc', exact: true})).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('textbox', {name: 'Assembly source', exact: true})).toBeFocused();
  await fillSource('color = $09\n');
  await page.getByRole('tab', {name: 'main.s', exact: true}).click();
  await fillSource('.org $600\n.include "math.inc"\nlda #color\n');
  await page.getByRole('tab', {name: 'Assembly', exact: true}).click();
  await expect(page.locator('.try-row').filter({hasText: 'lda #$09'})).toBeVisible();
  await page.getByRole('button', {name: 'Load Project', exact: true}).click();
  const load = page.getByRole('dialog', {name: 'Load Project'});
  await load.getByRole('textbox', {name: 'Save current files as'}).fill('New project');
  await load.getByRole('button', {name: 'Save to browser'}).click();
  await expect(load.getByRole('status')).toContainText('Saved "New project"');
  await page.reload();
  await page.getByRole('button', {name: 'Load Project', exact: true}).click();
  await load.getByRole('button', {name: 'New project', exact: true}).click();
  await page.getByRole('tab', {name: 'math.inc', exact: true}).click();
  await expect(page.locator('#fallback')).toHaveValue('color = $09\n');
});

test('theme footer stays at the page bottom', async () => {
  await page.setViewportSize({width: 1440, height: 1200});
  await page.goto('explore/');
  await expect(page.locator('.try-status')).toHaveText('');
  const footer = page.getByRole('contentinfo');
  await expect(footer.getByRole('button', {name: 'Change theme'})).toBeVisible();
  const bounds = await footer.boundingBox();
  expect(bounds).not.toBeNull();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  expect(Math.abs(bounds!.y + bounds!.height - height)).toBeLessThanOrEqual(1);
  await page.setViewportSize({width: 390, height: 844});
  const bottom = await footer.evaluate(element => {
    const footerBottom = element.getBoundingClientRect().bottom + scrollY;
    return {footerBottom, pageBottom: document.documentElement.scrollHeight,
      contentBottom: document.querySelector('main')!.getBoundingClientRect().bottom + scrollY};
  });
  expect(Math.abs(bottom.footerBottom - bottom.pageBottom)).toBeLessThanOrEqual(1);
  const narrowBounds = await footer.boundingBox();
  expect(narrowBounds!.y).toBeGreaterThanOrEqual(bottom.contentBottom);
});

test('touch fallback, themes, and no-JavaScript message', async () => {
  const touch = await browser.newContext({hasTouch: true, isMobile: true,
    viewport: {width: 390, height: 844}});
  const page = await touch.newPage();
  await page.goto('http://127.0.0.1:4173/js65/explore/');
  await expect(page.locator('.try-status')).toHaveText('');
  await expect(page.getByRole('checkbox', {name: 'Plain text editor'})).toHaveCount(0);
  await expect(page.getByRole('textbox', {name: 'Assembly source', exact: true})).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await expect(page.locator('.monaco-editor.vs-dark')).toHaveCount(1);
  await touch.close();
  const noScript = await browser.newContext({javaScriptEnabled: false});
  const staticPage = await noScript.newPage();
  await staticPage.goto('http://127.0.0.1:4173/js65/explore/');
  expect(await staticPage.locator('noscript').textContent()).toContain('Use the js65 CLI');
  await noScript.close();
});

test('unrelated pages do not fetch playground assets', async () => {
  const assets: string[] = [];
  page.on('request', request => { if (request.url().includes('try-me-assets')) assets.push(request.url()); });
  await page.goto('./');
  expect(assets).toEqual([]);
});

test('Monaco prototype and browser measurements', async () => {
  const started = Date.now();
  await page.goto('explore/');
  await expect(page.locator('.try-status')).toHaveText('');
  const startupMs = Date.now() - started;
  const result = await page.evaluate(async () => {
    const url = '/js65/__test/prototype.js';
    const {probe} = await import(url);
    return probe('lda #$01\nsta $0200\n');
  });
  expect(result.exactText).toBe('lda #$01\nsta $0200\n');
  expect(result.disposed).toBe(true);
  expect(result.decorationCount).toBe(1);
  expect(result.tokens.flat()).toContain('keyword.js65');
  expect(result.tokens.flat()).toContain('number.js65');
  expect(result.tokens.flat()).toContain('type.identifier.js65');
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  console.log(JSON.stringify({startupMs, editMs: result.editMs, retainedHeapBytes: heap.usedSize}));
  await page.screenshot({path: 'build/playwright/desktop.png', fullPage: true});
});

test('Monaco undo, includes, macros, and worker crash recovery', async () => {
  await page.goto('explore/');
  await expect(page.locator('.try-status')).toHaveText('');
  await page.getByRole('tab', {name: 'Assembly', exact: true}).click();
  await page.locator('.view-lines').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('nop');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.try-row').filter({hasText: 'nop'})).toHaveCount(0);
  const source = page.locator('#fallback');
  await page.getByRole('tab', {name: 'values.inc', exact: true}).click();
  await fillSource('.macro emit value\nlda #value\n.endmacro\nemit 7\n');
  await page.getByRole('tab', {name: 'main.s', exact: true}).click();
  await fillSource('.org $600\n.include "values.inc"\n');
  const instruction = page.locator('.try-row').filter({hasText: 'lda #$07'});
  await expect(instruction).toBeVisible();
  await expect(instruction).toHaveAttribute('title', /values.inc:4/);
  await instruction.click();
  await expect(page.getByRole('tab', {name: 'values.inc', exact: true})).toHaveAttribute('aria-selected', 'true');
  await page.route('**/compiler-worker.js', route => route.fulfill({
    contentType: 'text/javascript', body: 'throw new Error("Worker fixture failure");',
  }));
  await fillSource(await source.inputValue() + '\n');
  await expect(page.locator('.try-status')).toContainText('Worker fixture failure');
  await expect(page.getByRole('link', {name: 'Download .lst'})).toBeHidden();
  await page.unroute('**/compiler-worker.js');
  await fillSource(await source.inputValue() + '\n');
  await expect(instruction).toBeVisible();
});


