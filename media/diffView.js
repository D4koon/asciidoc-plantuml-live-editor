// @ts-check
// Showing what changed when the preview is one side of a diff. The extension
// sends the changed lines of every file involved; they are mapped onto what
// is rendered: diagram elements (by their source line), diagrams as a whole
// (e.g. for a changed skinparam), and the blocks of an AsciiDoc document.

/**
 * @typedef {{ changed: number[], ends: number[], gaps: number[], touched?: number[] }} FileChanges
 * @typedef {{ side: 'old' | 'new', files: Record<string, FileChanges> }} Diff
 * @typedef {{ origin: import('../src/diagrams').Origin | null, text: string }} DiagramLine
 *   A line of a diagram's source as the engine saw it, with its Origin.
 * @typedef {{ box: HTMLElement, mark: HTMLElement, uri: string, start: number, end: number, has: (uri: string, line: number) => boolean, diagram?: HTMLElement }} Region
 *   Something rendered from the lines `start`..`end` of `uri`: a diagram or a block.
 *   `mark` gets the change highlight, `box` the markers for removed or added lines.
 */

const MARKS = ['pv-diff', 'pv-diff-diagram', 'pv-diff-block', 'pv-diff-gap-before', 'pv-diff-gap-after', 'pv-diff-current'];

/**
 * @param {{
 *   container: HTMLElement,
 *   nav: HTMLElement,
 *   post: (message: object) => void,
 *   diagramLines: (diagram: HTMLElement) => DiagramLine[],
 *   blocks: () => { el: HTMLElement, uri: string, start: number, end: number }[],
 * }} options
 */
export function setupDiffView({ container, nav, post, diagramLines, blocks }) {
  /** @type {Diff | undefined} */
  let diff;
  /** @type {HTMLElement[]} */
  let targets = [];
  let current = -1;
  let unplaced = 0;
  /** What is rendered from which lines, for scrolling both sides together. */
  /** @type {Region[]} */
  let regions = [];

  const count = /** @type {HTMLElement} */ (nav.querySelector('.pv-diff-count'));
  nav.querySelector('.pv-diff-prev')?.addEventListener('click', () => go(-1));
  nav.querySelector('.pv-diff-next')?.addEventListener('click', () => go(1));
  window.addEventListener('keydown', (e) => {
    if (!diff || e.key !== 'F7' || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    e.preventDefault();
    go(e.shiftKey ? -1 : 1);
  });

  function clear() {
    for (const cls of MARKS) {
      for (const el of [...container.querySelectorAll(`.${cls}`)]) el.classList.remove(cls);
    }
  }

  /** Marks the changes on what is rendered now. Call after each render. */
  function apply() {
    clear();
    document.body.classList.toggle('pv-diff-old', diff?.side === 'old');
    document.body.classList.toggle('pv-diff-new', diff?.side === 'new');
    nav.hidden = !diff;
    targets = [];
    unplaced = 0;
    if (!diff) return;

    /** @type {Map<string, Map<number, number>>} changed line → last line of its paragraph, by file */
    const changed = new Map();
    /** @type {Map<string, Set<number>>} */
    const gaps = new Map();
    /** @type {Map<string, Set<number>>} lines whose paragraph lost or gained lines */
    const touched = new Map();
    for (const [uri, f] of Object.entries(diff.files)) {
      changed.set(uri, new Map(f.changed.map((line, i) => [line, f.ends[i] ?? line])));
      gaps.set(uri, new Set(f.gaps));
      touched.set(uri, new Set(f.touched ?? []));
    }
    const isChanged = (/** @type {string} */ uri, /** @type {number} */ line) => !!changed.get(uri)?.has(line);
    /** Changed lines not yet shown by anything, as "uri\u0000line". */
    const pending = new Set();
    for (const [uri, lines] of changed) for (const line of lines.keys()) pending.add(`${uri}\u0000${line}`);
    const shown = (/** @type {string} */ uri, /** @type {number} */ line) => pending.delete(`${uri}\u0000${line}`);

    /** @type {Region[]} */
    regions = [];
    for (const node of container.querySelectorAll('.diagram')) {
      const diagram = /** @type {HTMLElement} */ (node);
      const lines = diagramLines(diagram);
      const region = diagramRegion(diagram, lines);
      if (region) regions.push(region);
      if (markDiagram(diagram, lines, isChanged, gaps, shown)) diagram.classList.add('pv-diff-diagram');
    }
    for (const { el, uri, start, end } of blocks()) {
      const region = { box: el, mark: el, uri, start, end, has: (/** @type {string} */ u, /** @type {number} */ l) => u === uri && l >= start && l <= end };
      regions.push(region);
      let hit = false;
      for (let line = start; line <= end; line++) {
        if (isChanged(uri, line)) {
          hit = true;
          shown(uri, line);
        }
        // Lines removed or added on the other side, within the block or its paragraph.
        if ((line > start && gaps.get(uri)?.has(line)) || touched.get(uri)?.has(line)) hit = true;
      }
      if (hit) el.classList.add('pv-diff-block');
    }

    // Changed lines that render as nothing of their own (a block title, block
    // attributes, a [plantuml] line) belong to the block right below them.
    for (const key of [...pending]) {
      const [uri, lineText] = key.split('\u0000');
      const line = Number(lineText);
      const end = changed.get(uri)?.get(line) ?? line;
      const below = regions
        .filter((r) => r.uri === uri && r.start > line && r.start <= end + 1)
        .sort((a, b) => a.start - b.start)[0];
      if (below) {
        below.mark.classList.add(below.diagram ? 'pv-diff-diagram' : 'pv-diff-block');
        pending.delete(key);
      }
    }
    unplaced = pending.size;

    // Lines only the other side has, between two regions: a marker where they were.
    for (const [uri, positions] of gaps) {
      const own = regions.filter((r) => r.uri === uri).sort((a, b) => a.start - b.start);
      for (const gap of positions) {
        // Inside a region, or part of a block's paragraph: that is marked already.
        const inside = own.some((r) => r.has(uri, gap) && r.has(uri, gap - 1));
        const joined = [gap - 1, gap].some((line) => touched.get(uri)?.has(line) && own.some((r) => !r.diagram && r.has(uri, line)));
        if (inside || joined) continue;
        const next = own.find((r) => r.start >= gap);
        const last = own[own.length - 1];
        if (next) next.box.classList.add('pv-diff-gap-before');
        else if (last) last.box.classList.add('pv-diff-gap-after');
      }
    }

    targets = [...container.querySelectorAll('.pv-diff-block, .pv-diff-diagram, .pv-diff-gap-before, .pv-diff-gap-after')]
      .map((el) => /** @type {HTMLElement} */ (el))
      .filter((el, _, all) => !all.some((other) => other !== el && el.contains(other)));
    current = -1;
    updateCount();
  }

  function updateCount() {
    const n = targets.length;
    const position = current >= 0 ? `${current + 1} of ${n}` : `${n} ${n === 1 ? 'change' : 'changes'}`;
    count.textContent = n === 0 && unplaced === 0 ? 'No visible changes' : position;
    count.title =
      (unplaced ? `${unplaced} changed line(s) don't show in the rendering (e.g. attributes or comments). ` : '') +
      'F7 / Shift+F7: next / previous change';
    for (const button of nav.querySelectorAll('button')) /** @type {HTMLButtonElement} */ (button).disabled = n === 0;
  }

  function go(/** @type {number} */ step) {
    if (targets.length === 0) return;
    targets[current]?.classList.remove('pv-diff-current');
    current = current < 0 ? (step > 0 ? 0 : targets.length - 1) : (current + step + targets.length) % targets.length;
    const target = targets[current];
    target.classList.add('pv-diff-current');
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    updateCount();
  }

  // ------------------------------------------------- synced scrolling ---
  // The side being scrolled reports what is at the top of its view (a line of
  // a file, and how far into it); the extension maps that line to the other
  // version, and the other side scrolls the same content to the top.

  // Scroll events caused by following the other side are not reported back:
  // they come shortly after, and at the position that following set.
  let followingUntil = 0;
  let followedTop = -1;
  let reportTimer = 0;

  container.addEventListener('scroll', () => {
    if (!diff || performance.now() < followingUntil || Math.abs(container.scrollTop - followedTop) < 2) return;
    followedTop = -1;
    if (reportTimer) return;
    reportTimer = window.setTimeout(() => {
      reportTimer = 0;
      const position = topPosition();
      if (position) post({ type: 'diffScroll', ...position });
    }, 30);
  });

  function topPosition() {
    if (container.scrollTop <= 0) return { edge: 'top' };
    if (container.scrollTop + container.clientHeight >= container.scrollHeight - 1) return { edge: 'bottom' };
    const top = container.getBoundingClientRect().top;
    const placed = regions
      .filter((region) => region.box.isConnected)
      .map((region) => ({ region, rect: region.box.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height > 0);
    // The innermost (smallest) region covering the top of the view, else the first one below it.
    const covering = placed.filter(({ rect }) => rect.top <= top && rect.bottom > top).sort((x, y) => x.rect.height - y.rect.height)[0];
    if (covering) {
      return { uri: covering.region.uri, line: covering.region.start, fraction: (top - covering.rect.top) / covering.rect.height, gap: 0 };
    }
    const below = placed.filter(({ rect }) => rect.top > top).sort((x, y) => x.rect.top - y.rect.top)[0];
    return below && { uri: below.region.uri, line: below.region.start, fraction: 0, gap: below.rect.top - top };
  }

  /** Scrolls so that the content the other side shows at its top is at the top here. */
  function follow(/** @type {{ uri?: string, line?: number, fraction?: number, gap?: number, edge?: string }} */ position) {
    let target;
    if (position.edge === 'top') target = 0;
    else if (position.edge === 'bottom') target = container.scrollHeight;
    else {
      const { uri, line = 0 } = position;
      const own = regions.filter((r) => r.uri === uri && r.box.isConnected);
      const region =
        own.find((r) => r.has(uri ?? '', line)) ??
        own.filter((r) => r.start <= line).sort((a, b) => b.start - a.start)[0] ??
        own.sort((a, b) => a.start - b.start)[0];
      if (!region) return;
      const r = region.box.getBoundingClientRect();
      const top = container.getBoundingClientRect().top;
      target = container.scrollTop + (r.top - top) + (position.fraction ?? 0) * r.height - (position.gap ?? 0);
    }
    if (Math.abs(container.scrollTop - target) < 1) return;
    followingUntil = performance.now() + 200;
    container.scrollTop = target;
    followedTop = container.scrollTop; // clamped at the ends
  }

  return {
    follow,
    /** Sets the changes to show (undefined: not a diff any more) and shows them. */
    set(/** @type {Diff | undefined} */ value) {
      diff = value;
      apply();
    },
    apply,
  };
}

/**
 * The region of a diagram: the lines of the file it is written in. In a
 * document, its markers go on the whole block (with its title).
 * @param {HTMLElement} diagram
 * @param {DiagramLine[]} lines
 * @returns {Region | undefined}
 */
function diagramRegion(diagram, lines) {
  const home = lines.find((l) => l.origin)?.origin?.uri;
  if (!home) return undefined;
  const own = lines.flatMap((l) => (l.origin && l.origin.uri === home ? [l.origin.line] : []));
  const set = new Set(lines.flatMap((l) => (l.origin ? [`${l.origin.uri}\u0000${l.origin.line}`] : [])));
  const box = /** @type {HTMLElement} */ (diagram.closest('.pv-adoc-diagram-block') ?? diagram);
  return {
    box,
    mark: diagram,
    diagram,
    uri: home,
    start: Math.min(...own),
    end: Math.max(...own),
    has: (uri, line) => set.has(`${uri}\u0000${line}`),
  };
}

/**
 * Highlights the changed elements of a diagram. Returns whether anything in
 * it changed, also what has no element of its own (e.g. a skinparam).
 * @param {HTMLElement} diagram
 * @param {DiagramLine[]} lines
 * @param {(uri: string, line: number) => boolean} isChanged
 * @param {Map<string, Set<number>>} gaps
 * @param {(uri: string, line: number) => boolean} shown
 */
function markDiagram(diagram, lines, isChanged, gaps, shown) {
  const changedAt = lines.map((l) => !!l.origin && isChanged(l.origin.uri, l.origin.line));
  let any = changedAt.some(Boolean);
  // Lines removed or added on the other side, between two lines of this diagram.
  lines.forEach((l, i) => {
    const prev = lines[i - 1]?.origin;
    const origin = l.origin;
    if (origin && prev && prev.uri === origin.uri && prev.line === origin.line - 1 && gaps.get(origin.uri)?.has(origin.line)) any = true;
  });
  lines.forEach((l, i) => changedAt[i] && l.origin && shown(l.origin.uri, l.origin.line));
  const svg = diagram.querySelector('svg');
  if (!svg || !any) return any;

  const matched = new Set();
  for (const group of svg.querySelectorAll('g[data-source-line]')) {
    const index = Number(group.getAttribute('data-source-line'));
    if (changedAt[index]) {
      group.classList.add('pv-diff');
      matched.add(index);
    }
  }
  // Lines without an element of their own (class members, note text, …):
  // texts that appear in a changed line and in no unchanged one.
  // Lines the engine was given without them being written anywhere count as neither.
  const unchanged = lines.filter((l, i) => l.origin && !changedAt[i]).map((l) => l.text);
  const open = lines.filter((_, i) => changedAt[i] && !matched.has(i)).map((l) => l.text);
  if (open.length) {
    for (const text of svg.querySelectorAll('text')) {
      const value = (text.textContent ?? '').trim();
      if (value.length < 2 || text.closest('.pv-diff')) continue;
      if (open.some((line) => line.includes(value)) && !unchanged.some((line) => line.includes(value))) {
        text.classList.add('pv-diff');
      }
    }
  }
  return true;
}
