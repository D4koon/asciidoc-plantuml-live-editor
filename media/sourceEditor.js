// @ts-check
// Embedded Monaco editor for the split view. Keeps a model in sync with the
// VS Code document: local edits are reported through `onEdit`, and text
// coming from VS Code is applied as a minimal edit so the cursor stays put.

/**
 * Monaco's API; it ships no types for its AMD build.
 * @typedef {any} Monaco
 */

/** @type {Promise<Monaco> | undefined} */
let monacoPromise;

/** Loads Monaco's AMD build from `base` (a URL ending in "/"). */
function loadMonaco(/** @type {string} */ base) {
  monacoPromise ??= new Promise((resolve, reject) => {
    const workerMain = `${base}vs/base/worker/workerMain.js`;
    // Workers can't be created from webview resource URLs, so bootstrap one from a blob.
    /** @type {any} */ (window).MonacoEnvironment = {
      getWorkerUrl: () =>
        URL.createObjectURL(
          new Blob(
            [`self.MonacoEnvironment = { baseUrl: ${JSON.stringify(base)} }; importScripts(${JSON.stringify(workerMain)});`],
            { type: 'text/javascript' }
          )
        ),
    };
    const script = document.createElement('script');
    script.src = `${base}vs/loader.js`;
    script.onload = () => {
      const amdRequire = /** @type {any} */ (window).require;
      amdRequire.config({ paths: { vs: `${base}vs` } });
      amdRequire(['vs/editor/editor.main'], () => resolve(/** @type {any} */ (window).monaco), reject);
    };
    script.onerror = () => reject(new Error('Failed to load the Monaco editor'));
    document.head.appendChild(script);
  });
  return monacoPromise;
}

/**
 * @param {HTMLElement} container
 * @param {{ base: string, text: string, eol: string, language: 'plantuml' | 'asciidoc', onEdit: (edit: { version: number, changes: { offset: number, length: number, text: string }[], text: string }) => void }} options
 */
export async function createSourceEditor(container, { base, text, eol, language, onEdit }) {
  const monaco = await loadMonaco(base);
  registerPlantUml(monaco);
  registerAsciiDoc(monaco);
  applyTheme(monaco);

  const model = monaco.editor.createModel(text, language);
  setEol(monaco, model, eol);

  const style = getComputedStyle(document.body);
  const editor = monaco.editor.create(container, {
    model,
    theme: 'vscode-current',
    automaticLayout: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordBasedSuggestions: 'currentDocument',
    fontFamily: style.getPropertyValue('--vscode-editor-font-family').trim() || undefined,
    fontSize: parseFloat(style.getPropertyValue('--vscode-editor-font-size')) || 14,
    renderLineHighlight: 'line',
    tabSize: 2,
    wordWrap: language === 'asciidoc' ? 'on' : 'off',
  });

  // Edits made here, numbered so stale text from VS Code can be recognised.
  let version = 0;
  let applyingRemote = false;
  model.onDidChangeContent((/** @type {any} */ e) => {
    if (applyingRemote) return;
    version++;
    onEdit({
      version,
      changes: e.changes.map((/** @type {any} */ c) => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text })),
      text: model.getValue(),
    });
  });

  return {
    /**
     * Applies text from VS Code. Ignored while edits made here have not been
     * acknowledged, since it would roll them back; a later update follows.
     */
    setSource(/** @type {string} */ newText, /** @type {string} */ newEol, /** @type {number} */ ackVersion) {
      if (ackVersion < version) return;
      applyingRemote = true;
      try {
        setEol(monaco, model, newEol);
        const current = model.getValue();
        if (current === newText) return;
        let start = 0;
        while (start < current.length && start < newText.length && current[start] === newText[start]) start++;
        let endCurrent = current.length;
        let endNew = newText.length;
        while (endCurrent > start && endNew > start && current[endCurrent - 1] === newText[endNew - 1]) {
          endCurrent--;
          endNew--;
        }
        const range = monaco.Range.fromPositions(model.getPositionAt(start), model.getPositionAt(endCurrent));
        model.pushEditOperations([], [{ range, text: newText.slice(start, endNew) }], () => null);
      } finally {
        applyingRemote = false;
      }
    },
    /** Replaces the content with another file (navigating the include overview); edit versions restart. */
    setFile(/** @type {string} */ newText, /** @type {string} */ newEol, /** @type {'plantuml' | 'asciidoc'} */ newLanguage) {
      applyingRemote = true;
      try {
        monaco.editor.setModelLanguage(model, newLanguage);
        editor.updateOptions({ wordWrap: newLanguage === 'asciidoc' ? 'on' : 'off' });
        setEol(monaco, model, newEol);
        model.setValue(newText);
        version = 0;
        editor.setScrollPosition({ scrollTop: 0, scrollLeft: 0 });
      } finally {
        applyingRemote = false;
      }
    },
    focus: () => editor.focus(),
    /** Selects a (zero-based) line and scrolls it into view, without taking focus. */
    revealLine(/** @type {number} */ line) {
      const lineNumber = line + 1;
      if (lineNumber > model.getLineCount()) return;
      editor.setSelection(new monaco.Selection(lineNumber, 1, lineNumber, model.getLineMaxColumn(lineNumber)));
      editor.revealLineInCenterIfOutsideViewport(lineNumber);
    },
    /** Re-reads the VS Code theme colours (call after a theme change). */
    refreshTheme: () => applyTheme(monaco),
  };
}

/**
 * @param {Monaco} monaco
 * @param {any} model a Monaco text model
 * @param {string} eol
 */
function setEol(monaco, model, eol) {
  const wanted = eol === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF;
  if (model.getEndOfLineSequence() !== wanted) model.setEOL(wanted);
}

/** Builds a Monaco theme from the VS Code theme colours exposed to the webview. */
function applyTheme(/** @type {Monaco} */ monaco) {
  const cls = document.body.classList;
  const base = cls.contains('vscode-high-contrast-light')
    ? 'hc-light'
    : cls.contains('vscode-high-contrast')
      ? 'hc-black'
      : cls.contains('vscode-dark')
        ? 'vs-dark'
        : 'vs';
  const style = getComputedStyle(document.body);
  /** @type {Record<string, string>} */
  const colors = {};
  for (const [monacoKey, cssVar] of [
    ['editor.background', '--vscode-editor-background'],
    ['editor.foreground', '--vscode-editor-foreground'],
    ['editorLineNumber.foreground', '--vscode-editorLineNumber-foreground'],
    ['editorLineNumber.activeForeground', '--vscode-editorLineNumber-activeForeground'],
    ['editorCursor.foreground', '--vscode-editorCursor-foreground'],
    ['editor.selectionBackground', '--vscode-editor-selectionBackground'],
    ['editor.lineHighlightBackground', '--vscode-editor-lineHighlightBackground'],
    ['editorIndentGuide.background', '--vscode-editorIndentGuide-background'],
  ]) {
    const value = style.getPropertyValue(cssVar).trim();
    // Monaco only accepts hex colours.
    if (/^#[0-9a-f]{3,8}$/i.test(value)) colors[monacoKey] = value;
  }
  monaco.editor.defineTheme('vscode-current', { base, inherit: true, rules: [], colors });
  monaco.editor.setTheme('vscode-current');
}

let registered = false;
let asciiDocRegistered = false;

/** Registers a Monarch tokenizer for AsciiDoc: structure and inline markup, not a full parser. */
function registerAsciiDoc(/** @type {Monaco} */ monaco) {
  if (asciiDocRegistered) return;
  asciiDocRegistered = true;
  monaco.languages.register({ id: 'asciidoc' });
  monaco.languages.setLanguageConfiguration('asciidoc', {
    comments: { lineComment: '//', blockComment: ['////', '////'] },
    brackets: [['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '[', close: ']' },
      { open: '(', close: ')' },
    ],
  });
  monaco.languages.setMonarchTokensProvider('asciidoc', {
    tokenizer: {
      root: [
        [/^\/{4,}\s*$/, 'comment', '@blockComment'],
        [/^\/\/.*$/, 'comment'],
        [/^\[plantuml\b[^\]]*\]\s*$/, 'type', '@diagram'],
        // Listing, literal and passthrough blocks hold no AsciiDoc markup.
        [/^-{4,}\s*$/, 'keyword.control', '@listing'],
        [/^\.{4,}\s*$/, 'keyword.control', '@literal'],
        [/^\+{4,}\s*$/, 'keyword.control', '@passthrough'],
        [/^={1,6}\s.*$/, 'keyword'],
        [/^:[\w-]+!?:/, 'variable'],
        [/^\[.*\]\s*$/, 'type'],
        [/^\.(?=\S).*$/, 'type'],
        [/^(-{4,}|\.{4,}|_{4,}|\*{4,}|={4,}|\+{4,})\s*$/, 'keyword.control'],
        [/^\s*(\*+|-|\.+|\d+\.)\s/, 'keyword'],
        [/^[\w-]+::\S*\[[^\]]*\]/, 'tag'],
        [/\b(?:https?|mailto|link|xref|image|include|kbd):\S*?\[[^\]]*\]/, 'tag'],
        [/<<[^>]+>>/, 'tag'],
        [/\{[\w-]+\}/, 'variable'],
        [/`[^`]+`/, 'string'],
        [/\*[^*\s](?:[^*]*[^*\s])?\*/, 'strong'],
        [/_[^_\s](?:[^_]*[^_\s])?_/, 'emphasis'],
      ],
      blockComment: [
        [/^\/{4,}\s*$/, 'comment', '@pop'],
        [/.*/, 'comment'],
      ],
      listing: [
        [/^-{4,}\s*$/, 'keyword.control', '@pop'],
        [/.*/, 'string'],
      ],
      literal: [
        [/^\.{4,}\s*$/, 'keyword.control', '@pop'],
        [/.*/, 'string'],
      ],
      passthrough: [
        [/^\+{4,}\s*$/, 'keyword.control', '@pop'],
        [/.*/, 'string'],
      ],
      // After [plantuml]: an optional title, then the block, highlighted as PlantUML.
      diagram: [
        [/^\.(?=\S).*$/, 'type'],
        [/^-{4,}\s*$/, { token: 'keyword.control', switchTo: '@diagramListing', nextEmbedded: 'plantuml' }],
        [/^\.{4,}\s*$/, { token: 'keyword.control', switchTo: '@diagramLiteral', nextEmbedded: 'plantuml' }],
        [/^/, '', '@pop'],
      ],
      diagramListing: [[/^-{4,}\s*$/, { token: 'keyword.control', next: '@pop', nextEmbedded: '@pop' }]],
      diagramLiteral: [[/^\.{4,}\s*$/, { token: 'keyword.control', next: '@pop', nextEmbedded: '@pop' }]],
    },
  });
}

/** Registers a Monarch tokenizer for PlantUML (mirrors syntaxes/plantuml.tmLanguage.json). */
function registerPlantUml(/** @type {Monaco} */ monaco) {
  if (registered) return;
  registered = true;
  monaco.languages.register({ id: 'plantuml' });
  monaco.languages.setLanguageConfiguration('plantuml', {
    comments: { lineComment: "'", blockComment: ["/'", "'/"] },
    brackets: [['{', '}'], ['[', ']'], ['(', ')']],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"', notIn: ['string'] },
    ],
  });
  monaco.languages.setMonarchTokensProvider('plantuml', {
    ignoreCase: true,
    elements: [
      'actor', 'boundary', 'control', 'entity', 'database', 'collections', 'queue', 'participant', 'usecase',
      'class', 'abstract', 'interface', 'enum', 'annotation', 'protocol', 'struct', 'exception', 'metaclass',
      'object', 'map', 'json', 'yaml', 'component', 'node', 'artifact', 'cloud', 'folder', 'frame', 'file',
      'package', 'namespace', 'rectangle', 'card', 'storage', 'agent', 'stack', 'hexagon', 'person', 'state',
      'diamond', 'circle', 'label', 'archimate', 'port', 'portin', 'portout',
    ],
    controls: [
      'alt', 'else', 'opt', 'loop', 'par', 'break', 'critical', 'group', 'end', 'ref', 'over', 'box', 'activate',
      'deactivate', 'destroy', 'create', 'return', 'note', 'endnote', 'rnote', 'hnote', 'of', 'on', 'as', 'left',
      'right', 'top', 'bottom', 'start', 'stop', 'kill', 'detach', 'if', 'then', 'elseif', 'endif', 'while',
      'endwhile', 'repeat', 'fork', 'again', 'split', 'switch', 'case', 'endswitch', 'partition', 'swimlane',
      'backward', 'is', 'extends', 'implements',
    ],
    directives: [
      'skinparam', 'hide', 'show', 'scale', 'title', 'header', 'footer', 'caption', 'legend', 'endlegend',
      'autonumber', 'newpage', 'allowmixing', 'mainframe', 'direction',
    ],
    tokenizer: {
      root: [
        [/^\s*'.*$/, 'comment'],
        [/\/'/, 'comment', '@blockComment'],
        [/^\s*@(start|end)\w+/, 'keyword.control'],
        [/^\s*!\w+/, 'keyword.directive'],
        [/\$\w+/, 'variable'],
        [/"/, 'string', '@string'],
        [/<<[^>]+>>/, 'tag'],
        [/#(?:[0-9a-f]{3,8}\b|[a-z]+\b)/, 'number.hex'],
        [/[<*o+#x}{]?[-.=~]+(?:\[[^\]]*\])?(?:up|down|left|right|u|d|l|r)?[-.=~]*[>*o+#x{}]|<[-.=~]+/, 'operator'],
        [/[a-z_]\w*/, { cases: { '@elements': 'type', '@controls': 'keyword', '@directives': 'keyword', '@default': 'identifier' } }],
      ],
      blockComment: [
        [/'\//, 'comment', '@pop'],
        [/./, 'comment'],
      ],
      string: [
        [/\\./, 'string.escape'],
        [/"/, 'string', '@pop'],
        [/[^\\"]+/, 'string'],
      ],
    },
  });
}
