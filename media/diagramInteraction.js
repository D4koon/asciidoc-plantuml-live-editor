// @ts-check
// Click / double-click / Delete on the rendered diagram. Works out what was
// hit (element kind, its texts, the source-line hint from the SVG) and sends
// it with the diagram's lines to the extension, which maps it onto the files
// those lines came from.

const CONNECTION_CLASSES = ['message', 'link'];

/**
 * @typedef {{ hint?: number, qualifiedName?: string, texts: string[] }} ElementRef
 */

/**
 * @param {{
 *   container: HTMLElement,
 *   post: (message: object) => void,
 *   diagram: (diagramEl: HTMLElement) => Diagram | undefined,
 *   editable: boolean,
 *   onBackgroundDblClick: () => void,
 * }} options
 * @typedef {import('../src/diagrams').Diagram} Diagram
 *   Elements are located on a Diagram's lines (the SVG's data-source-line is
 *   an index into them).
 */
export function setupDiagramInteraction({ container, post, diagram, editable, onBackgroundDblClick }) {
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
    const target = hit && refFor(hit);
    if (!hit || !target) {
      select(undefined);
      return;
    }
    select(hit.group ?? hit.text);
    post({ type: 'select', ...target });
  });

  container.addEventListener('dblclick', (e) => {
    const hit = hitTest(/** @type {Element} */ (e.target));
    if (!hit?.text) {
      if (!hit) onBackgroundDblClick();
      return;
    }
    const target = editable ? refFor(hit) : undefined;
    if (!target) return; // read-only diagram
    e.preventDefault();
    const text = hit.text;
    editInline(text, (newText) => {
      post({
        type: 'rename',
        request: { ...target.ref, kind: textKind(hit.group, text), oldText: text.textContent ?? '', newText },
        diagram: target.diagram,
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
      const target = hit && refFor(hit);
      if (target) post({ type: 'delete', ...target });
      select(undefined);
    }
  });

  /**
   * @param {{ diagram: HTMLElement, group?: Element, text?: Element }} hit
   * @returns {{ ref: ElementRef, diagram: Diagram } | undefined} undefined when the diagram is unknown
   */
  function refFor(hit) {
    const source = diagram(hit.diagram);
    if (!source) return undefined;
    const line = hit.group?.getAttribute('data-source-line');
    /** @type {ElementRef} */
    const ref = {
      hint: line == null ? undefined : Number(line),
      qualifiedName: hit.group?.getAttribute('data-qualified-name') ?? undefined,
      texts: hit.group ? contentTexts(hit.group).map((t) => t.textContent ?? '') : [hit.text?.textContent ?? ''],
    };
    // A lifeline has no <text>, only a <title> with the participant's name.
    if (ref.texts.length === 0 && hit.group) {
      const title = hit.group.querySelector('title')?.textContent;
      if (title) ref.texts = [title];
    }
    return { ref, diagram: source };
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
