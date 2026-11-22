// @ts-check
// What Asciidoctor reported while rendering the document: a collapsed list
// at the top of the document, and a box where an include:: selecting lines
// or tags went wrong (the extension places those boxes, `pv-warning`).
// Clicking a warning reveals its line.

/** @typedef {import('../src/asciidoc').Warning} Warning */

/**
 * @param {{ container: HTMLElement, post: PostToExtension }} options
 * @returns {{ show: (warnings: Warning[]) => void }}
 */
export function setupWarnings({ container, post }) {
  /** @type {Warning[]} */
  let shown = [];
  // The list stays as the user left it across renders.
  let open = false;

  container.addEventListener('click', (e) => {
    const el = /** @type {Element} */ (e.target).closest?.('[data-warning]');
    const warning = el instanceof HTMLElement ? shown[Number(el.dataset.warning)] : undefined;
    if (warning?.line === undefined) return;
    post({ type: 'revealLine', line: warning.line, uri: warning.uri });
  });

  /** Fills the boxes in the document and lists `warnings` above it. */
  function show(/** @type {Warning[]} */ warnings) {
    shown = warnings;
    for (const node of container.querySelectorAll('.adoc .pv-warning[data-warning]')) {
      const box = /** @type {HTMLElement} */ (node);
      const warning = warnings[Number(box.dataset.warning)];
      if (warning) fill(box, warning);
    }

    let list = container.querySelector(':scope > details.pv-warnings');
    if (warnings.length === 0) {
      list?.remove();
      return;
    }
    if (!list) {
      list = document.createElement('details');
      list.className = 'pv-warnings';
      list.addEventListener('toggle', () => (open = /** @type {HTMLDetailsElement} */ (list).open));
      container.prepend(list);
    }
    const details = /** @type {HTMLDetailsElement} */ (list);
    details.open = open;
    const summary = document.createElement('summary');
    summary.textContent = `⚠ ${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`;
    const items = warnings.map((warning, index) => {
      const item = document.createElement('div');
      item.dataset.warning = String(index);
      fill(item, warning);
      return item;
    });
    details.replaceChildren(summary, ...items);
  }

  return { show };
}

/** Shows `warning` in `el`: Asciidoctor's words, then the file and line. */
function fill(/** @type {HTMLElement} */ el, /** @type {Warning} */ warning) {
  el.classList.add('pv-warning-item', `pv-warning-${warning.severity}`);
  el.classList.toggle('pv-warning-located', warning.line !== undefined);
  const name = decodeURIComponent(warning.uri.replace(/[?#].*$/, '').replace(/^.*\//, ''));
  const where = document.createElement('span');
  where.className = 'pv-warning-where';
  where.textContent = warning.line === undefined ? name : `${name}:${warning.line + 1}`;
  el.replaceChildren(`${warning.severity === 'error' ? '✖' : '⚠'} ${warning.text} — `, where);
}
