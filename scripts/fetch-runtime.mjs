// Downloads a pinned js-plantuml release (the TeaVM successor of
// plantuml/plantuml-core) and extracts the runtime files into media/vendor.
//
//   npm run fetch-runtime                 # version from package.json "plantumlJs.version"
//   npm run fetch-runtime -- 1.2026.8     # a specific release
//   npm run fetch-runtime -- snapshot     # the rolling snapshot build
//   npm run fetch-runtime -- --force      # re-download even if already present
//
// PLANTUML_JS_VERSION may also be used to choose the version.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'media', 'vendor');
const markerFile = join(outDir, 'VERSION.json');

const args = process.argv.slice(2);
const force = args.includes('--force');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const version = (args.find((a) => !a.startsWith('--')) ?? process.env.PLANTUML_JS_VERSION ?? pkg.plantumlJs?.version)
  ?.replace(/^v/, '');
if (!version) {
  throw new Error('No js-plantuml version: set "plantumlJs.version" in package.json or pass one as an argument.');
}

const isSnapshot = version === 'snapshot';
const tag = isSnapshot ? 'snapshot' : `v${version}`;
const asset = `js-plantuml-${isSnapshot ? 'SNAPSHOT' : version}.zip`;
const url = `https://github.com/plantuml/plantuml/releases/download/${tag}/${asset}`;

// The snapshot tag moves, so it is always re-downloaded.
if (!force && !isSnapshot) {
  const current = await readFile(markerFile, 'utf8').then(JSON.parse, () => undefined);
  if (current?.version === version) {
    console.log(`js-plantuml ${version} already present in media/vendor`);
    process.exit(0);
  }
}

/**
 * Files the engine needs at runtime. Everything else in the release zip
 * (demo pages, their CSS/JS, favicons) is skipped. The *.min.js files are the
 * standard library (<C4/...>, <awslib/...>, ...), loaded on demand.
 */
const RUNTIME_FILES = new Set(['plantuml.js', 'viz-global.js', 'themes.js', 'emoji.js', 'openiconic.js']);
const isRuntimeFile = (name) => RUNTIME_FILES.has(name) || /^[\w.-]+\.min\.js$/.test(name);

process.stdout.write(`Downloading ${url} … `);
const response = await fetch(url);
if (!response.ok) {
  throw new Error(`${url}: HTTP ${response.status}`);
}
const zip = new Uint8Array(await response.arrayBuffer());
console.log(`${(zip.length / 1024 / 1024).toFixed(1)} MB`);

const entries = unzipSync(zip, { filter: (file) => isRuntimeFile(file.name) });
for (const required of ['plantuml.js', 'viz-global.js']) {
  if (!entries[required]) {
    throw new Error(`${asset} does not contain ${required}; the release layout may have changed.`);
  }
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
let total = 0;
for (const [name, data] of Object.entries(entries)) {
  await writeFile(join(outDir, name), data);
  total += data.length;
}

await writeFile(
  markerFile,
  JSON.stringify(
    {
      version,
      source: url,
      sha256: createHash('sha256').update(zip).digest('hex'),
      fetchedAt: new Date().toISOString(),
    },
    null,
    2
  ) + '\n'
);
console.log(
  `Extracted ${Object.keys(entries).length} files (${(total / 1024 / 1024).toFixed(1)} MB) for js-plantuml ${version} into media/vendor`
);
