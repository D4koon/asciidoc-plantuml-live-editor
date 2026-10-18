// @ts-check
// Editing an AsciiDoc document in the rendered view. The extension tags each
// editable block with a `pv-src-<index>` role and sends its source lines;
// clicking a block reveals it in the source, double-clicking replaces it with
// a text box holding its AsciiDoc source (so inline markup survives edits).

/** @typedef {import('../src/asciidoc').AsciiDocBlock} SourceBlock */

/**
 * Marks the rendered elements of `blocks` with `data-src`: sections on their
 * heading, list items on their text, the document title on its `<h1>`.
 * @param {HTMLElement} root
 * @param {SourceBlock[]} blocks
 * @param {number | undefined} titleBlock
 */
export function tagBlocks(root, blocks, titleBlock) {
  for (const el of root.querySelectorAll('[class*="pv-src-"]')) {
    const match = /(?:^|\s)pv-src-(\d+)(?:\s|$)/.exec(el.className);
    if (!match || !blocks[Number(match[1])]) continue;
    const isSection = /(?:^|\s)sect[1-6](?:\s|$)/.test(el.className);
    const target = isSection
      ? el.querySelector(':scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6')
      : el.tagName === 'LI'
        ? (el.querySelector(':scope > p') ?? el)
        : el;
    if (target instanceof HTMLElement) target.dataset.src = match[1];
  }
  const title = root.querySelector('.adoc > h1');
  if (titleBlock !== undefined && title instanceof HTMLElement) title.dataset.src = String(titleBlock);
}

/**
 * @param {{
 *   container: HTMLElement,
 *   post: PostToExtension,
 *   blocks: () => SourceBlock[],
 *   onEditEnd: () => void,
 *   editable: boolean,
 * }} options
 * @returns {{ isEditing: () => boolean }}
 */
export function setupDocumentEditing({ container, post, blocks, onEditEnd, editable }) {
  let editing = false;

  /** The editable block under `target`, ignoring diagrams and links. */
  function blockAt(/** @type {EventTarget | null} */ target) {
    if (!(target instanceof Element) || target.closest('.diagram, a[href], .pv-block-edit')) return undefined;
    const el = /** @type {HTMLElement | null} */ (target.closest('.adoc [data-src]'));
    const block = el && blocks()[Number(el.dataset.src)];
    return el && block ? { el, block } : undefined;
  }

  container.addEventListener('click', (e) => {
    const hit = blockAt(e.target);
    // Don't jump while the user is selecting text.
    if (!hit || editing || String(window.getSelection() ?? '')) return;
    post({ type: 'revealLine', line: hit.block.start, uri: hit.block.uri });
  });

  container.addEventListener('dblclick', (e) => {
    const hit = blockAt(e.target);
    // Tables and description lists are only located; a version (the old side of a diff) can't be edited.
    if (!hit || editing || !editable || hit.block.kind === 'none') return;
    e.preventDefault();
    window.getSelection()?.removeAllRanges();
    edit(hit.el, hit.block);
  });

  /** Replaces `el` with a text box holding the block's source until committed or cancelled. */
  function edit(/** @type {HTMLElement} */ el, /** @type {SourceBlock} */ block) {
    editing = true;
    const box = document.createElement('textarea');
    box.className = 'pv-block-edit';
    box.value = block.text;
    box.spellcheck = true;
    box.title = block.kind === 'line' ? 'Enter to apply, Escape to cancel' : 'Ctrl+Enter or click outside to apply, Escape to cancel';
    el.after(box);
    el.classList.add('pv-editing');
    const fit = () => {
      box.style.height = 'auto';
      box.style.height = `${box.scrollHeight + 2}px`;
    };
    fit();
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);

    let done = false;
    const finish = (/** @type {boolean} */ save) => {
      if (done) return;
      done = true;
      const value = box.value.replace(/\s+$/, '');
      box.remove();
      el.classList.remove('pv-editing');
      editing = false;
      if (save && value !== block.text) {
        post({ type: 'editBlock', start: block.start, end: block.end, oldText: block.text, newText: value, uri: block.uri });
      }
      onEditEnd();
    };
    box.addEventListener('input', fit);
    box.addEventListener('keydown', (e) => {
      // Keep keys away from the diagram shortcuts and VS Code while typing here.
      e.stopPropagation();
      if (e.key === 'Escape') finish(false);
      else if (e.key === 'Enter' && (block.kind === 'line' || e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        finish(true);
      }
    });
    box.addEventListener('blur', () => finish(true));
  }

  return { isEditing: () => editing };
}
