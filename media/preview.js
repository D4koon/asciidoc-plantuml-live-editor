// @ts-check
// Webview side of the preview: renders each @start…/@end… block with the
// in-browser PlantUML engine (TeaVM build) and keeps the result in sync.

import { setupDiagramInteraction } from './diagramInteraction.js';
import { createSourceEditor } from './sourceEditor.js';
import { setupDocumentEditing, tagBlocks } from './documentEditing.js';
import { setupIncludeOverview } from './includeOverview.js';
import { setupDiffView } from './diffView.js';

const vscode = acquireVsCodeApi();

/**
 * Sends a message to the extension.
 * @param {import('../src/protocol').FromWebview} message
 */
function post(message) {
  vscode.postMessage(message);
}

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

function saveState(/** @type {Partial<typeof state>} */ patch) {
  Object.assign(state, patch);
  vscode.setState(state);
}

/**
 * The latest content from the extension: the Diagrams of a PlantUML file,
 * or a converted AsciiDoc document (`asciidoc`) and its Diagrams.
 * @typedef {import('../src/diagrams').Diagram} Diagram
 * @type {import('../src/protocol').UpdateMessage | undefined}
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
    post({ type: 'ready' });
  } catch (e) {
    setStatus(`Failed to load the PlantUML engine: ${errorText(e)}`, true);
  }
}

/** Renders one diagram source to SVG markup. */
function renderOne(/** @type {string} */ source, /** @type {boolean} */ dark) {
  return new Promise((resolve, reject) => {
    try {
      renderToString(source.split(/\r\n|\r|\n/), resolve, reject, { dark });
    } catch (e) {
      reject(e);
    }
  });
}

// --------------------------------------------------------------- render ---

/** The Diagram each rendered diagram element shows. @type {WeakMap<HTMLElement, Diagram>} */
const diagramOf = new WeakMap();

/** The Diagram a rendered diagram element shows. */
function diagramAt(/** @type {HTMLElement} */ el) {
  return diagramOf.get(el);
}

/** A diagram element to render: shows `diagram`. */
function target(/** @type {HTMLElement} */ el, /** @type {Diagram} */ diagram) {
  diagramOf.set(el, diagram);
  return { el, source: diagram.lines.join('\n'), error: diagram.error };
}

function isDark(/** @type {import('../src/protocol').UpdateMessage['theme']} */ theme) {
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
    /** @type {{ svg?: string, error?: string } | undefined} */
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

/** PlantUML files: one container per Diagram. */
function diagramTargets() {
  if (!latest) return [];
  const diagrams = latest.diagrams;
  // Reuse existing containers so unchanged diagrams don't flicker.
  while (diagramsEl.children.length > diagrams.length) {
    diagramsEl.lastElementChild?.remove();
  }
  while (diagramsEl.children.length < diagrams.length) {
    const el = document.createElement('div');
    el.className = 'diagram';
    diagramsEl.appendChild(el);
  }
  return diagrams.map((diagram, i) => {
    // Kept current even when the diagram itself is unchanged (lines above may have moved).
    return target(/** @type {HTMLElement} */ (diagramsEl.children[i]), diagram);
  });
}

// ------------------------------------------------------------- asciidoc ---

/** The format being shown; navigating the include overview can switch it. */
let renderedFormat = document.body.dataset.format;
let isDocument = renderedFormat === 'asciidoc';
/** @type {string | undefined} */
let renderedHtml;
/** Editable blocks of the document currently shown (they belong to `renderedHtml`). */
/** @type {import('./documentEditing.js').SourceBlock[]} */
let renderedBlocks = [];
/** @type {Diagram[]} */
let renderedDiagrams = [];

/** AsciiDoc: inserts the converted document and returns its diagram placeholders. */
function documentTargets() {
  if (latest?.format !== 'asciidoc') return [];
  const converted = latest.asciidoc;
  // While a block is being edited, keep the document as it is; the edit's end re-renders.
  if (!documentEditing.isEditing()) {
    // Diagrams and blocks are referenced by index, so with the same HTML only their
    // data changes (e.g. an edited !include file changes a diagram, not the HTML).
    renderedBlocks = converted.blocks;
    renderedDiagrams = latest.diagrams;
    if (converted.html !== renderedHtml) {
      renderedHtml = converted.html;
      const scrollTop = diagramsEl.scrollTop;
      diagramsEl.innerHTML = `<div class="adoc">${converted.html}</div>`;
      tagBlocks(diagramsEl, renderedBlocks, converted.titleBlock);
      diagramsEl.scrollTop = scrollTop;
    }
  }
  const diagrams = renderedDiagrams;
  return [...diagramsEl.querySelectorAll('.pv-adoc-diagram')].map((node) => {
    const el = /** @type {HTMLElement} */ (node);
    return target(el, diagrams[Number(el.dataset.diagram)] ?? { lines: [], origins: [], error: 'Diagram not found' });
  });
}

const documentEditing = setupDocumentEditing({
  container: diagramsEl,
  post,
  blocks: () => renderedBlocks,
  onEditEnd: () => void renderAll(),
  editable: document.body.dataset.readonly !== 'true',
});

// ----------------------------------------------------------------- diff ---

const diffView = setupDiffView({
  container: diagramsEl,
  nav: /** @type {HTMLElement} */ (document.getElementById('diff-nav')),
  post,
  diagram: diagramAt,
  blocks: () => {
    const rendered = latest?.nav?.rendered;
    if (!rendered) return [];
    return [...diagramsEl.querySelectorAll('.adoc [data-src]')].flatMap((node) => {
      const el = /** @type {HTMLElement} */ (node);
      const block = renderedBlocks[Number(el.dataset.src)];
      return block ? [{ el, uri: block.uri ?? rendered, start: block.start, end: block.end, text: block.text }] : [];
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
    post({ type: 'openLink', href });
  }
});

// ----------------------------------------------------------------- zoom ---

function applyZoom() {
  diagramsEl.style.setProperty('--zoom', String(zoom));
  zoomResetBtn.textContent = `${Math.round(zoom * 100)}%`;
  saveState({ zoom });
}

function setZoom(/** @type {number} */ value) {
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
  post,
  diagram: diagramAt,
  editable: document.body.dataset.readonly !== 'true',
  onBackgroundDblClick: () => {
    // In a document, double-click is for selecting words.
    if (!split && !isDocument) post({ type: 'openSource' });
  },
});
document.getElementById('edit-source')?.addEventListener('click', () => post({ type: 'openSource' }));

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
 * @type {import('../src/protocol').SourceMessage | undefined}
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
        onEdit: (edit) => post({ type: 'edit', uri: editorFile, ...edit }),
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
    post({ type: 'split', split });
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
  post,
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

window.addEventListener('message', (/** @type {MessageEvent<import('../src/protocol').ToWebview>} */ event) => {
  const message = event.data;
  switch (message.type) {
    case 'update':
      latest = message;
      saveState({ uri: message.uri });
      includeOverview.update(message.includes, message.nav);
      void renderAll();
      break;
    case 'reveal':
      sourceEditor?.revealLine(message.line);
      break;
    case 'diff':
      diffView.set('files' in message ? message : undefined);
      break;
    case 'diffScroll':
      diffView.follow(message);
      break;
    case 'source':
      latestSource = message;
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
      post({ type: 'svg', requestId: message.requestId, svgs });
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

function setStatus(/** @type {string} */ text, isError = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

function errorText(/** @type {unknown} */ e) {
  if (e instanceof Error) return e.message;
  return String(e);
}

applyZoom();
applySplit();
void loadEngine();
