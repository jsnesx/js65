import type * as Monaco from 'monaco-editor';
import type {ListingIndex, ListingRow} from '../../src/listing.ts';
import {instructionHelp} from './instructions.ts';

export class ListingView {
  private rows: {element: HTMLElement; row: ListingRow}[] = [];
  private readonly pre = document.createElement('pre');

  constructor(container: HTMLElement,
    private readonly associate: (row?: ListingRow, reveal?: boolean) => void) {
    container.append(this.pre);
    this.pre.addEventListener('pointerleave', () => associate());
  }

  render(text: string, index: ListingIndex): void {
    const lines = text.replace(/\n$/, '').split('\n');
    if (index.version !== 1 || index.rows.length !== lines.length) {
      throw new Error('Listing index does not match the artifact');
    }
    this.rows = [];
    this.pre.replaceChildren();
    const fragment = document.createDocumentFragment();
    for (const row of index.rows) {
      const line = lines[row.row - 1];
      const element = document.createElement('span');
      element.className = 'try-row';
      const help = instructionHelp(row);
      if (row.instruction && help) {
        const {start, end} = row.instruction;
        const token = document.createElement('mark');
        token.textContent = line.slice(start, end);
        token.title = help;
        element.append(line.slice(0, start), token, line.slice(end));
      } else element.textContent = line;
      if (row.source || help) {
        element.tabIndex = 0;
        const chain = row.expansion.map(s => `${s.file}:${s.line}`).join(' -> ');
        element.title = [help, chain].filter(Boolean).join('\n');
        element.setAttribute('aria-label', `${line}. ${element.title}`);
        element.addEventListener('pointerenter', () => this.associate(row));
        element.addEventListener('focus', () => this.associate(row));
        element.addEventListener('blur', () => this.associate());
        element.addEventListener('click', () => this.associate(row, true));
        element.addEventListener('keydown', event => {
          if (event.key === 'Enter') this.associate(row, true);
        });
      }
      this.rows.push({element, row});
      fragment.append(element);
    }
    this.pre.append(fragment);
  }

  select(file: string, selection: Monaco.Selection): void {
    for (const {element, row} of this.rows) {
      element.classList.toggle('selected', row.source?.file === file &&
        row.source.line >= selection.startLineNumber && row.source.line <= selection.endLineNumber);
    }
  }

  clear(): void { this.pre.replaceChildren(); this.rows = []; this.associate(); }
}
