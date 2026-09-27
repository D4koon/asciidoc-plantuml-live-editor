// @ts-check
// Click / double-click / Delete on the rendered diagram. Works out what was
// hit (element kind, its texts, the source-line hint from the SVG) and sends
// it to the extension, which maps it onto the document.

const CONNECTION_CLASSES = ['message', 'link'];

/**
 * @typedef {{ start: number, end: number }} Block
 * @typedef {{ block: Block, hint?: number, qualifiedName?: string, texts: string[] }} ElementRef
 */

/**
 * @param {{
 *   container: HTMLElement,
 *   post: (message: object) => void,
 *   locate: (diagramEl: HTMLElement, sourceLine: number | undefined) => { block: Block, hint?: number } | undefined,
 *   elsewhere: (diagramEl: HTMLElement, sourceLine: number | undefined, texts: string[]) => { uri: string, line: number } | undefined,
 *   expand: (diagramEl: HTMLElement) => Expanded | undefined,
 *   editable: boolean,
 *   onBackgroundDblClick: () => void,
 * }} options
 * @typedef {{ lines: string[], origins: ([string, number] | null)[] }} Expanded
 *   A diagram that includes other files, as the engine sees it, with each
 *   line's file and line (null for lines added along the way). Renames and
 *   deletes are planned on it and applied to every file involved.
 */
export function setupDiagramInteraction({ container, post, locate, elsewhere, expand, editable, onBackgroundDblClick }) {
  /** @type {Element | undefined} */
  let selected;
  container.tabIndex = 0;

  function select(/** @type {Element | undefined} */ el) {
    selected?.classList.remove('pv-selected');
    selected = el;
    selected?.classList.add('pv-selected');
  }

  container.addEventListener('click', (e) => {
    const hit = hitTest(/** @type {Element} */ (e.target));
    container.focus({ preventScroll: true });
    const source = hit && sourceElsewhere(hit);
    if (hit && source) {
      // Defined in an included file: show that file's line in the source.
      select(hit.group ?? hit.text);
      post({ type: 'revealLine', ...source });
      return;
    }
    const ref = hit && refFor(hit);
    if (!hit || !ref) {
      select(undefined);
      return;
    }
    select(hit.group ?? hit.text);
    post({ type: 'select', ref, expanded: expand(hit.diagram) });
  });

  container.addEventListener('dblclick', (e) => {
    const hit = hitTest(/** @type {Element} */ (e.target));
    if (!hit?.text) {
      if (!hit) onBackgroundDblClick();
      return;
    }
    const ref = editable ? refFor(hit) : undefined;
    if (!ref) return; // read-only diagram
    e.preventDefault();
    const text = hit.text;
    editInline(text, (newText) => {
      post({
        type: 'rename',
        request: { ...ref, kind: textKind(hit.group, text), oldText: text.textContent ?? '', newText },
        expanded: expand(hit.diagram),
      });
    });
  });

  container.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape') {
      select(undefined);
    } else if (editable && (e.key === 'Delete' || e.key === 'Backspace') && selected && isConnection(selected)) {
      e.preventDefault();
      const hit = hitTest(selected);
      const ref = hit && refFor(hit);
      if (ref) post({ type: 'delete', ref, expanded: expand(hit.diagram) });
      select(undefined);
    }
  });

  /**
   * The file and line of a hit element when it comes from another file than
   * the previewed one (an included file), else undefined.
   * @param {{ diagram: HTMLElement, group?: Element, text?: Element }} hit
   */
  function sourceElsewhere(hit) {
    const line = hit.group?.getAttribute('data-source-line');
    const texts = hit.group ? contentTexts(hit.group).map((t) => t.textContent ?? '') : [hit.text?.textContent ?? ''];
    return elsewhere(hit.diagram, line == null ? undefined : Number(line), texts);
  }

  /**
   * @param {{ diagram: HTMLElement, group?: Element, text?: Element }} hit
   * @returns {ElementRef | undefined} undefined when the diagram can't be edited
   */
  function refFor(hit) {
    const line = hit.group?.getAttribute('data-source-line');
    const sourceLine = line == null ? undefined : Number(line);
    // A diagram with included files is edited on its expanded text, where the source line is the index.
    const expanded = expand(hit.diagram);
    const located = expanded ? { block: { start: 0, end: expanded.lines.length - 1 }, hint: sourceLine } : locate(hit.diagram, sourceLine);
    if (!located) return undefined;
    const { block, hint } = located;
    /** @type {ElementRef} */
    const ref = {
      block,
      hint,
      qualifiedName: hit.group?.getAttribute('data-qualified-name') ?? undefined,
      texts: hit.group ? contentTexts(hit.group).map((t) => t.textContent ?? '') : [hit.text?.textContent ?? ''],
    };
    // A lifeline has no <text>, only a <title> with the participant's name.
    if (ref.texts.length === 0 && hit.group) {
      const title = hit.group.querySelector('title')?.textContent;
      if (title) ref.texts = [title];
    }
    return ref;
  }
}

/** Finds the diagram element under `target`: its tagged group and/or text. */
function hitTest(/** @type {Element} */ target) {
  const diagram = /** @type {HTMLElement | null} */ (target.closest('.diagram'));
  if (!diagram || !target.closest('svg')) return undefined;
  const group = target.closest('g[data-source-line], g[data-qualified-name]') ?? undefined;
  const textEl = target.closest('text') ?? undefined;
  const text = textEl && isContentText(textEl) ? textEl : undefined;
  if (!group && !text) return undefined;
  return { diagram, group, text };
}

function isConnection(/** @type {Element} */ el) {
  return CONNECTION_CLASSES.some((c) => el.classList.contains(c));
}

/** Texts that carry content, excluding class-type badges ("C", "I", …) and «stereotypes». */
function contentTexts(/** @type {Element} */ group) {
  return [...group.querySelectorAll('text')].filter(isContentText);
}

function isContentText(/** @type {Element} */ text) {
  const value = (text.textContent ?? '').trim();
  if (!value) return false;
  if (value.length === 1 && text.getAttribute('font-family') === 'monospace') return false;
  return !/^«.*»$/.test(value);
}

/** 'label' on connections; on entities the first text is the name, later ones members. */
function textKind(/** @type {Element | undefined} */ group, /** @type {Element} */ text) {
  if (!group) return 'text';
  if (isConnection(group)) return 'label';
  return contentTexts(group)[0] === text ? 'name' : 'member';
}

/** Shows a text box over an SVG text; calls `commit` with the new value on Enter or blur. */
function editInline(/** @type {Element} */ text, /** @type {(value: string) => void} */ commit) {
  const original = text.textContent ?? '';
  const rect = text.getBoundingClientRect();
  const input = document.createElement('input');
  input.className = 'pv-inline-edit';
  input.value = original;
  input.style.left = `${rect.left - 4}px`;
  input.style.top = `${rect.top - 3}px`;
  input.style.minWidth = `${Math.max(rect.width + 40, 80)}px`;
  input.style.height = `${rect.height + 6}px`;
  input.style.fontSize = `${Math.max(11, rect.height * 0.8)}px`;
  document.body.appendChild(input);
  input.focus();
  input.select();
  text.classList.add('pv-editing');

  let done = false;
  const finish = (/** @type {boolean} */ save) => {
    if (done) return;
    done = true;
    text.classList.remove('pv-editing');
    input.remove();
    const value = input.value;
    if (save && value.trim() && value !== original) commit(value);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}
