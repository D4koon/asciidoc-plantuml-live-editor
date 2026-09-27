// Copies the parts of Monaco's AMD build used by the split view's embedded
// editor into media/monaco. Language packs are skipped: PlantUML registers
// its own tokenizer.
//
//   npm run copy-monaco

import { copyFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILES = [
  'vs/loader.js',
  'vs/editor/editor.main.js',
  'vs/editor/editor.main.css',
  'vs/base/worker/workerMain.js',
  'vs/base/browser/ui/codicons/codicon/codicon.ttf',
];

const require = createRequire(import.meta.url);
const source = join(dirname(require.resolve('monaco-editor/package.json')), 'min');
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'media', 'monaco');

await rm(outDir, { recursive: true, force: true });
for (const file of FILES) {
  const target = join(outDir, file);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(source, file), target);
}
console.log(`Copied ${FILES.length} Monaco files (v${require('monaco-editor/package.json').version}) into media/monaco`);
