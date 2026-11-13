import * as monaco from 'monaco-editor/esm/vs/editor/editor.api.js';
import {registerLanguage} from '../app/language.ts';

export function probe(text: string) {
  const language = registerLanguage(monaco);
  const before = monaco.editor.getModels().length;
  const container = document.createElement('div');
  container.style.cssText = 'width:600px;height:400px';
  document.body.append(container);
  const model = monaco.editor.createModel(text, 'js65', monaco.Uri.parse('file:///probe/listing.s'));
  const editor = monaco.editor.create(container, {model, readOnly: true});
  const decoration = editor.createDecorationsCollection([{range: new monaco.Range(1, 1, 1, 1),
    options: {isWholeLine: true, glyphMarginClassName: 'probe-breakpoint'}}]);
  const tokens = monaco.editor.tokenize('label: lda #$01 ; text\n.macro emit\n.jsbegin\nconst a = 1;\n.jsend', 'js65');
  const start = performance.now();
  for (let i = 0; i < 100; i++) model.applyEdits([{range: new monaco.Range(1, 1, 1, 1), text: ' '}]);
  const editMs = (performance.now() - start) / 100;
  const value = {tokens: tokens.map(line => line.map(t => t.type)),
    decorationCount: decoration.length, exactText: editor.getValue().slice(100), editMs};
  decoration.clear();
  editor.dispose();
  model.dispose();
  container.remove();
  language.dispose();
  return {...value, disposed: monaco.editor.getModels().length === before};
}
