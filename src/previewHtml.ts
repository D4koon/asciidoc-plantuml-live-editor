// The preview webview's page. Kept free of VS Code so the webview tests load
// the same page, Content-Security-Policy included.

export interface PreviewPage {
  /** The URL of a file in the extension's `media` folder, as the webview may load it. */
  media: (...parts: string[]) => string;
  /** The origin the webview's resources are served from (`webview.cspSource`). */
  cspSource: string;
  /** A fresh random value; only scripts carrying it run. */
  nonce: string;
  /** AsciiDoc: the URL relative images resolve against (the document's folder, ending in "/"). */
  base?: string;
  format: 'plantuml' | 'asciidoc';
  /** `editor`: the in-place custom editor; `panel`: a preview beside the text editor. */
  kind: 'editor' | 'panel';
  /** Whether the split view was last open. */
  split: boolean;
  readOnly: boolean;
}

export function previewHtml({ media, cspSource, nonce, base, format, kind, split, readOnly }: PreviewPage): string {
  const csp = [
    `default-src 'none'`,
    `img-src ${cspSource} data: https:`,
    `style-src ${cspSource} 'unsafe-inline'`,
    `font-src ${cspSource} data:`,
    // Viz.js compiles Graphviz from an embedded WebAssembly module.
    `script-src 'nonce-${nonce}' ${cspSource} 'wasm-unsafe-eval'`,
    // Monaco's language worker is bootstrapped from a blob URL.
    `worker-src blob:`,
  ].join('; ');
  const baseTag = base === undefined ? '' : `\n  <base href="${base}">`;

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">${baseTag}
  <link rel="stylesheet" href="${media('preview.css')}">
  <link rel="stylesheet" href="${media('asciidoc.css')}">
  <title>PlantUML Preview</title>
</head>
<body
  data-format="${format}"
  data-kind="${kind}"
  data-split="${split}"
  data-readonly="${readOnly}"
  data-engine="${media('vendor', 'plantuml.js')}"
  data-vendor="${media('vendor')}/"
  data-monaco="${media('monaco')}/">
  <div id="toolbar">
    <button id="split-toggle" title="Edit the source in this tab">Split</button>
    <button id="zoom-out" title="Zoom out">−</button>
    <button id="zoom-reset" title="Reset zoom">100%</button>
    <button id="zoom-in" title="Zoom in">+</button>
    <button id="zoom-fit" title="Fit to width">Fit</button>
    <span id="crumbs"></span>
    <span id="diff-nav" hidden>
      <button class="pv-diff-prev" title="Previous change (Shift+F7)">↑</button>
      <span class="pv-diff-count"></span>
      <button class="pv-diff-next" title="Next change (F7)">↓</button>
    </span>
    <span id="status">Loading PlantUML engine…</span>
    <button id="edit-source" title="Open the source in the VS Code text editor beside this tab">Edit Source</button>
  </div>
  <div id="main">
    <div id="source">
      <div id="source-editor"></div>
      <details id="includes" open><summary>Includes</summary><div id="include-tree"></div></details>
    </div>
    <div id="divider" title="Drag to resize"></div>
    <div id="diagrams"></div>
  </div>
  <script nonce="${nonce}" src="${media('vendor', 'viz-global.js')}"></script>
  <script nonce="${nonce}" type="module" src="${media('preview.js')}"></script>
</body>
</html>`;
}
