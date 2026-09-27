// @ts-check
// Webview side of the preview: renders each @start…/@end… block with the
// in-browser PlantUML engine (TeaVM build) and keeps the result in sync.

import { setupDiagramInteraction } from './diagramInteraction.js';
import { createSourceEditor } from './sourceEditor.js';
import { setupDocumentEditing, tagBlocks } from './documentEditing.js';
import { setupIncludeOverview } from './includeOverview.js';
import { setupDiffView } from './diffView.js';

const vscode = acquireVsCodeApi();

const mainEl = /** @type {HTMLElement} */ (document.getElementById('main'));
const sourceEditorEl = /** @type {HTMLElement} */ (document.getElementById('source-editor'));
const dividerEl = /** @type {HTMLElement} */ (document.getElementById('divider'));
const diagramsEl = /** @type {HTMLElement} */ (document.getElementById('diagrams'));
const statusEl = /** @type {HTMLElement} */ (document.getElementById('status'));
const zoomResetBtn = /** @type {HTMLButtonElement} */ (document.getElementById('zoom-reset'));
const splitBtn = /** @type {HTMLButtonElement} */ (document.getElementById('split-toggle'));

/** @type {{ uri?: string, zoom?: number, split?: boolean, sourceWidth?: number, includesOpen?: boolean }} */
const state = vscode.getState() ?? {};
let zoom = state.zoom ?? 1;

function saveState(patch) {
  Object.assign(state, patch);
  vscode.setState(state);
}

/**
 * The latest content from the extension: a PlantUML file (`text`) or a
 * converted AsciiDoc document (`html` + `diagrams`).
 * @type {{ format: string, text?: string, theme: string, lineMap?: number[], origins?: LineOrigins, nav?: { rendered: string }, html?: string, diagrams?: any[], blocks?: import('./documentEditing.js').SourceBlock[], titleBlock?: number } | undefined}
 */
let latest;
let generation = 0;

/** @type {(lines: string[], ok: (svg: string) => void, err: (e: unknown) => void, opts: object) => void} */
let renderToString;

window.PLANTUML_DEBUG = false;
// themes.js, emoji.js, openiconic.js and the stdlib bundles (<C4/...> etc.)
// are loaded on demand from the bundled vendor folder.
window.PLANTUML_STDLIB_BASE = document.body.dataset.vendor;

// ---------------------------------------------------------------- engine ---

async function loadEngine() {
  try {
    const engine = await import(/** @type {string} */ (document.body.dataset.engine));
    renderToString = engine.renderToString;
    setStatus('');
    vscode.postMessage({ type: 'ready' });
  } catch (e) {
    setStatus(`Failed to load the PlantUML engine: ${errorText(e)}`, true);
  }
}

/** Renders one diagram source to SVG markup. */
function renderOne(source, dark) {
  return new Promise((resolve, reject) => {
    try {
      renderToString(source.split(/\r\n|\r|\n/), resolve, reject, { dark });
    } catch (e) {
      reject(e);
    }
  });
}

// --------------------------------------------------------------- render ---

/**
 * Splits a document into its individual diagram sources. `start`/`end` are the
 * lines of the @start/@end markers in `text` (`-1`/`lines.length` when synthesized).
 */
function splitDiagrams(text) {
  /** @type {{ source: string, start: number, end: number }[]} */
  const blocks = [];
  const lines = text.split(/\r\n|\r|\n/);
  let start = -1;
  let kind = '';
  lines.forEach((line, i) => {
    const s = /^\s*@start(\w+)/.exec(line);
    if (s && start < 0) {
      start = i;
      kind = s[1];
      return;
    }
    const e = /^\s*@end(\w+)/.exec(line);
    if (e && start >= 0 && e[1] === kind) {
      blocks.push({ source: lines.slice(start, i + 1).join('\n'), start, end: i });
      start = -1;
    }
  });
  if (start >= 0) {
    // Unterminated block: close it so the user still sees something while typing.
    blocks.push({ source: [...lines.slice(start), `@end${kind}`].join('\n'), start, end: lines.length });
  }
  if (blocks.length === 0 && text.trim().length > 0) {
    blocks.push({ source: `@startuml\n${text}\n@enduml`, start: -1, end: lines.length });
  }
  return blocks;
}

/**
 * Converts a diagram's block and an SVG data-source-line (relative to the
 * block's @start line) into document lines, undoing !include expansion.
 */
function locateInDocument(/** @type {HTMLElement} */ el, /** @type {number | undefined} */ sourceLine) {
  const embedded = documentDiagrams.get(el);
  if (embedded) {
    // AsciiDoc: the extension sent the mapping; no block means read-only (included file).
    if (!embedded.block) return undefined;
    const line = sourceLine === undefined ? -1 : embedded.lineMap[sourceLine] ?? -1;
    return { block: embedded.block, hint: line >= 0 ? line : undefined };
  }
  const map =(/** @type {number} */ i) => (latest?.lineMap ? latest.lineMap[i] ?? -1 : i);
  const start = Number(el.dataset.start);
  const end = Number(el.dataset.end);
  const block = {
    start: start < 0 ? -1 : map(start),
    end: latest?.lineMap && end >= latest.lineMap.length ? Number.MAX_SAFE_INTEGER : map(end),
  };
  const hintLine = sourceLine === undefined ? -1 : map(start + sourceLine);
  return { block, hint: hintLine >= 0 ? hintLine : undefined };
}

/** @typedef {{ files: string[], lines: [number, number][] }} LineOrigins */

/**
 * Where a diagram element was written, when that is another file than the
 * previewed one (it came through an include). Elements without a source line
 * are looked up by their texts.
 */
function originElsewhere(/** @type {HTMLElement} */ el, /** @type {number | undefined} */ sourceLine, /** @type {string[]} */ texts) {
  const embedded = documentDiagrams.get(el);
  const origins = embedded ? embedded.origins : latest?.origins;
  if (!origins || !latest?.nav) return undefined;
  const lines = (embedded ? embedded.source : latest.text ?? '').split(/\r\n|\r|\n/);
  // PlantUML files: the diagram is a slice of the text starting at its @start line (-1 when synthesized).
  const offset = embedded ? 0 : Number(el.dataset.start);
  const last = embedded ? lines.length - 1 : Math.min(Number(el.dataset.end), lines.length - 1);
  let index = sourceLine === undefined ? -1 : offset + sourceLine;
  if (sourceLine === undefined) {
    const wanted = texts.filter((t) => t.trim());
    for (let i = Math.max(0, offset); i <= last && index < 0; i++) {
      if (wanted.some((t) => lines[i].includes(t))) index = i;
    }
  }
  const [file, line] = origins.lines[index] ?? [-1, -1];
  const uri = origins.files[file];
  return file >= 0 && uri !== latest.nav.rendered ? { uri, line } : undefined;
}

/**
 * A diagram's text as rendered, with each line's file and line, when it
 * includes other files than the previewed one; undefined otherwise (it is
 * then edited through the document, as before).
 */
function expandedDiagram(/** @type {HTMLElement} */ el) {
  const embedded = documentDiagrams.get(el);
  const origins = embedded ? embedded.origins : latest?.origins;
  if (!origins || !latest?.nav) return undefined;
  /** @type {string[]} */
  let lines;
  /** @type {[number, number][]} */
  let at;
  if (embedded) {
    lines = embedded.source.split(/\r\n|\r|\n/);
    at = origins.lines;
  } else {
    // PlantUML files: the diagram's lines of the text, from its @start to its @end (synthesized ones included).
    const all = (latest.text ?? '').split(/\r\n|\r|\n/);
    lines = [];
    at = [];
    for (let i = Number(el.dataset.start); i <= Number(el.dataset.end); i++) {
      const real = i >= 0 && i < all.length;
      lines.push(real ? all[i] : i < 0 ? '@startuml' : '@enduml');
      at.push(real ? origins.lines[i] : [-1, -1]);
    }
  }
  const rendered = latest.nav.rendered;
  /** @type {([string, number] | null)[]} */
  const located = at.map(([file, line]) => (file >= 0 ? [origins.files[file], line] : null));
  return located.some((o) => o && o[0] !== rendered) ? { lines, origins: located } : undefined;
}

function isDark(theme) {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  const cls = document.body.classList;
  return cls.contains('vscode-dark') || (cls.contains('vscode-high-contrast') && !cls.contains('vscode-high-contrast-light'));
}

/**
 * Render results by theme + source, so diagrams whose containers were
 * re-created (AsciiDoc re-conversion replaces the whole document) appear
 * instantly instead of rendering again.
 * @type {Map<string, { svg?: string, error?: string }>}
 */
let renderCache = new Map();

/** @typedef {{ el: HTMLElement, source: string, error?: string }} RenderTarget */

async function renderAll() {
  if (!latest || !renderToString) return;
  if (latest.format !== renderedFormat && !documentEditing.isEditing()) {
    // Navigating between an AsciiDoc document and a PlantUML file: start from an empty view.
    renderedFormat = latest.format;
    isDocument = renderedFormat === 'asciidoc';
    renderedHtml = undefined;
    diagramsEl.replaceChildren();
  }
  const current = ++generation;
  const dark = isDark(latest.theme);
  const targets = isDocument ? documentTargets() : diagramTargets();

  if (targets.length === 0) {
    setStatus(isDocument ? '' : 'Nothing to render');
    diffView.apply();
    return;
  }

  setStatus(targets.length > 1 ? `Rendering ${targets.length} diagrams…` : 'Rendering…');
  const cache = new Map();
  let failures = 0;
  for (const { el, source, error } of targets) {
    const key = `${dark}\u0000${source}\u0000${error ?? ''}`;
    let result = el.dataset.key === key ? { svg: el.dataset.svg ? el.innerHTML : undefined, error: el.textContent ?? '' } : undefined;
    if (result) {
      cache.set(key, result);
      if (!result.svg) failures++;
      continue;
    }
    result = error !== undefined ? { error } : renderCache.get(key);
    if (!result) {
      try {
        result = { svg: String(await renderOne(source, dark)) };
      } catch (e) {
        result = { error: errorText(e) };
      }
      if (current !== generation) return; // a newer edit superseded this pass
    }
    cache.set(key, result);
    if (result.svg !== undefined) {
      el.innerHTML = result.svg;
      el.classList.remove('error');
      el.dataset.svg = 'true';
    } else {
      failures++;
      el.textContent = result.error ?? '';
      el.classList.add('error');
      delete el.dataset.svg;
    }
    el.classList.toggle('dark', dark);
    el.dataset.key = key;
  }
  renderCache = cache;
  diffView.apply();
  applyZoom();
  setStatus(failures ? `${failures} diagram(s) failed to render` : '', failures > 0);
}

/** PlantUML files: one container per @start…/@end… block. */
function diagramTargets() {
  if (!latest) return [];
  const blocks = splitDiagrams(latest.text ?? '');
  // Reuse existing containers so unchanged diagrams don't flicker.
  while (diagramsEl.children.length > blocks.length) {
    diagramsEl.lastElementChild?.remove();
  }
  while (diagramsEl.children.length < blocks.length) {
    const el = document.createElement('div');
    el.className = 'diagram';
    diagramsEl.appendChild(el);
  }
  return blocks.map((block, i) => {
    const el = /** @type {HTMLElement} */ (diagramsEl.children[i]);
    // Kept current even when the diagram itself is unchanged (lines above may have moved).
    el.dataset.start = String(block.start);
    el.dataset.end = String(block.end);
    return { el, source: block.source };
  });
}

// ------------------------------------------------------------- asciidoc ---

/** The format being shown; navigating the include overview can switch it. */
let renderedFormat = document.body.dataset.format;
let isDocument = renderedFormat === 'asciidoc';
/** @type {string | undefined} */
let renderedHtml;
/**
 * Per-placeholder diagram info from the extension (line map, block range).
 * @type {WeakMap<HTMLElement, { source: string, lineMap: number[], origins?: LineOrigins, block?: { start: number, end: number }, error?: string }>}
 */
const documentDiagrams = new WeakMap();

/** Editable blocks of the document currently shown (they belong to `renderedHtml`). */
/** @type {import('./documentEditing.js').SourceBlock[]} */
let renderedBlocks = [];
/** @type {any[]} */
let renderedDiagrams = [];

/** AsciiDoc: inserts the converted document and returns its diagram placeholders. */
function documentTargets() {
  if (!latest?.html) return [];
  // While a block is being edited, keep the document as it is; the edit's end re-renders.
  if (!documentEditing.isEditing()) {
    // Diagrams and blocks are referenced by index, so with the same HTML only their
    // data changes (e.g. an edited !include file changes a diagram, not the HTML).
    renderedBlocks = latest.blocks ?? [];
    renderedDiagrams = latest.diagrams ?? [];
    if (latest.html !== renderedHtml) {
      renderedHtml = latest.html;
      const scrollTop = diagramsEl.scrollTop;
      diagramsEl.innerHTML = `<div class="adoc">${latest.html}</div>`;
      tagBlocks(diagramsEl, renderedBlocks, latest.titleBlock);
      diagramsEl.scrollTop = scrollTop;
    }
  }
  const diagrams = renderedDiagrams;
  return [...diagramsEl.querySelectorAll('.pv-adoc-diagram')].map((node) => {
    const el = /** @type {HTMLElement} */ (node);
    const info = diagrams[Number(el.dataset.diagram)] ?? { source: '', lineMap: [], error: 'Diagram not found' };
    documentDiagrams.set(el, info);
    return { el, source: info.source, error: info.error };
  });
}

const documentEditing = setupDocumentEditing({
  container: diagramsEl,
  post: (message) => vscode.postMessage(message),
  blocks: () => renderedBlocks,
  onEditEnd: () => void renderAll(),
  editable: document.body.dataset.readonly !== 'true',
});

// ----------------------------------------------------------------- diff ---

/**
 * Each line of a diagram as the engine saw it (index = the SVG's
 * data-source-line), with the file and line it came from.
 * @returns {import('./diffView.js').DiagramLine[]}
 */
function diagramLines(/** @type {HTMLElement} */ el) {
  const embedded = documentDiagrams.get(el);
  if (embedded) {
    const origins = embedded.origins;
    return embedded.source.split(/\r\n|\r|\n/).map((text, i) => {
      const [file, line] = origins?.lines[i] ?? [-1, -1];
      return { text, at: origins && file >= 0 ? [origins.files[file], line] : null };
    });
  }
  if (!latest?.nav || el.dataset.start === undefined) return [];
  const all = (latest.text ?? '').split(/\r\n|\r|\n/);
  const rendered = latest.nav.rendered;
  /** @type {import('./diffView.js').DiagramLine[]} */
  const lines = [];
  for (let i = Number(el.dataset.start); i <= Number(el.dataset.end); i++) {
    const real = i >= 0 && i < all.length;
    /** @type {[string, number] | null} */
    let at = null;
    if (real && latest.origins) {
      const [file, line] = latest.origins.lines[i] ?? [-1, -1];
      if (file >= 0) at = [latest.origins.files[file], line];
    } else if (real) {
      const line = latest.lineMap ? latest.lineMap[i] ?? -1 : i;
      if (line >= 0) at = [rendered, line];
    }
    lines.push({ text: real ? all[i] : '', at });
  }
  return lines;
}

const diffView = setupDiffView({
  container: diagramsEl,
  nav: /** @type {HTMLElement} */ (document.getElementById('diff-nav')),
  post: (message) => vscode.postMessage(message),
  diagramLines,
  blocks: () => {
    const rendered = latest?.nav?.rendered;
    if (!rendered) return [];
    return [...diagramsEl.querySelectorAll('.adoc [data-src]')].flatMap((node) => {
      const el = /** @type {HTMLElement} */ (node);
      const block = renderedBlocks[Number(el.dataset.src)];
      return block ? [{ el, uri: block.uri ?? rendered, start: block.start, end: block.end }] : [];
    });
  },
});

// Links inside the document: anchors scroll here, everything else goes to VS Code.
diagramsEl.addEventListener('click', (e) => {
  const link = /** @type {Element} */ (e.target).closest?.('.adoc a[href]');
  if (!link) return;
  e.preventDefault();
  const href = link.getAttribute('href') ?? '';
  if (href.startsWith('#')) {
    document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: 'smooth' });
  } else {
    vscode.postMessage({ type: 'openLink', href });
  }
});

// ----------------------------------------------------------------- zoom ---

function applyZoom() {
  diagramsEl.style.setProperty('--zoom', String(zoom));
  zoomResetBtn.textContent = `${Math.round(zoom * 100)}%`;
  saveState({ zoom });
}

function setZoom(value) {
  zoom = Math.min(8, Math.max(0.1, value));
  applyZoom();
}

function fitToWidth() {
  const widths = [...diagramsEl.querySelectorAll('.diagram > svg')].map((svg) => {
    const w = parseFloat(svg.getAttribute('width') ?? '');
    return Number.isFinite(w) ? w : svg.getBoundingClientRect().width / zoom;
  });
  const widest = Math.max(0, ...widths);
  if (widest > 0) setZoom((diagramsEl.clientWidth - 48) / widest);
}

document.getElementById('zoom-in')?.addEventListener('click', () => setZoom(zoom * 1.25));
document.getElementById('zoom-out')?.addEventListener('click', () => setZoom(zoom / 1.25));
document.getElementById('zoom-fit')?.addEventListener('click', fitToWidth);
zoomResetBtn.addEventListener('click', () => setZoom(1));
diagramsEl.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false }
);
setupDiagramInteraction({
  container: diagramsEl,
  post: (message) => vscode.postMessage(message),
  locate: locateInDocument,
  elsewhere: originElsewhere,
  expand: expandedDiagram,
  editable: document.body.dataset.readonly !== 'true',
  onBackgroundDblClick: () => {
    // In a document, double-click is for selecting words.
    if (!split && !isDocument) vscode.postMessage({ type: 'openSource' });
  },
});
document.getElementById('edit-source')?.addEventListener('click', () => vscode.postMessage({ type: 'openSource' }));

// ----------------------------------------------------------- split view ---
// Only the in-place preview (custom editor) offers the embedded source editor,
// for PlantUML files and AsciiDoc documents alike.

// A read-only version (e.g. the old side of a diff) can't be edited, so no editor either.
const readOnly = document.body.dataset.readonly === 'true';
const canSplit = document.body.dataset.kind === 'editor' && !readOnly;
let split = canSplit && (state.split ?? document.body.dataset.split === 'true');

/**
 * Latest raw source from VS Code, kept so the editor can be created on demand.
 * `uri` is the file shown in the editor: the root, or a file it includes.
 * @type {{ uri: string, language: 'plantuml' | 'asciidoc', text: string, eol: string, ackVersion: number } | undefined}
 */
let latestSource;
/** The file the embedded editor holds (its edits are sent for this file). */
let editorFile = '';
/** @type {Awaited<ReturnType<typeof createSourceEditor>> | undefined} */
let sourceEditor;
/** @type {Promise<void> | undefined} */
let sourceEditorLoading;

function applySplit() {
  document.body.classList.toggle('split', split);
  splitBtn.classList.toggle('active', split);
  splitBtn.title = split ? 'Hide the source editor' : 'Edit the source in this tab';
  if (state.sourceWidth) mainEl.style.setProperty('--source-width', `${state.sourceWidth}%`);
  if (split) void ensureSourceEditor();
}

async function ensureSourceEditor() {
  if (sourceEditor || sourceEditorLoading || !latestSource) return;
  sourceEditorLoading = (async () => {
    try {
      setStatus('Loading editor…');
      const { uri, text, eol, language } = latestSource;
      const created = await createSourceEditor(sourceEditorEl, {
        base: /** @type {string} */ (document.body.dataset.monaco),
        text,
        eol,
        language,
        onEdit: (edit) => vscode.postMessage({ type: 'edit', uri: editorFile, ...edit }),
      });
      if (statusEl.textContent === 'Loading editor…') setStatus('');
      sourceEditor = created;
      editorFile = uri;
      // Catch up with anything that arrived while Monaco was loading.
      if (latestSource) applySource(latestSource);
      if (split) sourceEditor.focus();
    } catch (e) {
      setStatus(`Could not load the editor: ${errorText(e)}`, true);
    } finally {
      sourceEditorLoading = undefined;
    }
  })();
}

if (canSplit) {
  splitBtn.addEventListener('click', () => {
    split = !split;
    saveState({ split });
    vscode.postMessage({ type: 'split', split });
    applySplit();
    if (split) sourceEditor?.focus();
  });
} else {
  splitBtn.remove();
}

const includeOverview = setupIncludeOverview({
  panel: /** @type {HTMLDetailsElement} */ (document.getElementById('includes')),
  tree: /** @type {HTMLElement} */ (document.getElementById('include-tree')),
  crumbs: /** @type {HTMLElement} */ (document.getElementById('crumbs')),
  post: (message) => vscode.postMessage(message),
  open: state.includesOpen ?? true,
  onToggle: (open) => saveState({ includesOpen: open }),
});

dividerEl.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  dividerEl.setPointerCapture(e.pointerId);
  document.body.classList.add('resizing');
  const bounds = mainEl.getBoundingClientRect();
  const move = (/** @type {PointerEvent} */ ev) => {
    const percent = Math.min(85, Math.max(15, ((ev.clientX - bounds.left) / bounds.width) * 100));
    mainEl.style.setProperty('--source-width', `${percent}%`);
    state.sourceWidth = percent;
  };
  const up = () => {
    dividerEl.removeEventListener('pointermove', move);
    document.body.classList.remove('resizing');
    saveState({});
  };
  dividerEl.addEventListener('pointermove', move);
  dividerEl.addEventListener('pointerup', up, { once: true });
});

// ------------------------------------------------------------- messages ---

window.addEventListener('message', (event) => {
  const message = event.data;
  switch (message.type) {
    case 'update':
      latest = {
        format: message.format ?? renderedFormat,
        text: message.text,
        theme: message.theme,
        lineMap: message.lineMap,
        origins: message.origins,
        nav: message.nav,
        html: message.html,
        diagrams: message.diagrams,
        blocks: message.blocks,
        titleBlock: message.titleBlock,
      };
      saveState({ uri: message.uri });
      includeOverview.update(message.includes, message.nav);
      void renderAll();
      break;
    case 'reveal':
      sourceEditor?.revealLine(message.line);
      break;
    case 'diff':
      diffView.set(message.side ? { side: message.side, files: message.files } : undefined);
      break;
    case 'diffScroll':
      diffView.follow(message);
      break;
    case 'source':
      latestSource = { uri: message.uri, language: message.language, text: message.text, eol: message.eol, ackVersion: message.ackVersion };
      if (sourceEditor) {
        applySource(latestSource);
      } else if (split) {
        void ensureSourceEditor();
      }
      break;
    case 'requestSvg': {
      const svgs = [...diagramsEl.querySelectorAll('.diagram')].map((el) =>
        el instanceof HTMLElement && el.dataset.svg ? el.innerHTML : ''
      );
      vscode.postMessage({ type: 'svg', requestId: message.requestId, svgs });
      break;
    }
  }
});

/** Shows source from VS Code in the editor: an update of its file, or another file to switch to. */
function applySource(/** @type {NonNullable<typeof latestSource>} */ source) {
  if (!sourceEditor) return;
  if (source.uri !== editorFile) {
    editorFile = source.uri;
    sourceEditor.setFile(source.text, source.eol, source.language);
  } else {
    sourceEditor.setSource(source.text, source.eol, source.ackVersion);
  }
}

// Re-render when the VS Code color theme changes (only matters for "auto").
let lastThemeClass = themeClass();
new MutationObserver(() => {
  // Our own split/resizing classes also live on <body>; only react to theme changes.
  if (themeClass() === lastThemeClass) return;
  lastThemeClass = themeClass();
  sourceEditor?.refreshTheme();
  if (latest?.theme === 'auto') void renderAll();
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

function themeClass() {
  return [...document.body.classList].filter((c) => c.startsWith('vscode-')).join(' ');
}

// ---------------------------------------------------------------- utils ---

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function errorText(e) {
  if (e instanceof Error) return e.message;
  return String(e);
}

applyZoom();
applySplit();
void loadEngine();
