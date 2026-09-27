// @ts-check
// Overview of the files a document includes, shown under the split view's
// editor: the root file, then one row per directive, nested by the files that
// contain them. Clicking a file shows it in this tab (the root stays the tab's
// file); clicking a line number shows the file containing the directive, at it.

/**
 * @typedef {{
 *   directive: string, target: string, file: string, line: number, uri?: string,
 *   status: 'ok' | 'missing' | 'recursive' | 'once' | 'builtin' | 'blocked',
 *   children: IncludeNode[],
 * }} IncludeNode
 * @typedef {{ root: string, shown: string, rendered: string, dirty: string[] }} Navigation
 */

const STATUS_TEXT = {
  missing: 'not found',
  recursive: 'recursive, skipped',
  once: 'already included',
  blocked: 'outside the document folder',
};

/**
 * @param {{
 *   panel: HTMLDetailsElement,
 *   tree: HTMLElement,
 *   crumbs: HTMLElement,
 *   post: (message: object) => void,
 *   open: boolean,
 *   onToggle: (open: boolean) => void,
 * }} options
 */
export function setupIncludeOverview({ panel, tree, crumbs, post, open, onToggle }) {
  const summary = /** @type {HTMLElement} */ (panel.querySelector('summary'));
  panel.open = open;
  panel.addEventListener('toggle', () => onToggle(panel.open));

  /** @type {string | undefined} */
  let shown;

  const onClick = (/** @type {MouseEvent} */ e) => {
    const target = /** @type {Element} */ (e.target).closest('[data-uri]');
    if (!(target instanceof HTMLElement)) return;
    const line = target.dataset.line;
    post({ type: 'show', uri: target.dataset.uri, line: line === undefined ? undefined : Number(line) });
  };
  tree.addEventListener('click', onClick);
  crumbs.addEventListener('click', onClick);

  return {
    /**
     * @param {IncludeNode[] | undefined} includes the root's include tree
     * @param {Navigation | undefined} nav
     */
    update(includes = [], nav = undefined) {
      const key = JSON.stringify([includes, nav]);
      if (key === shown) return;
      shown = key;

      const files = new Set();
      const count = (/** @type {IncludeNode[]} */ nodes) =>
        nodes.forEach((n) => {
          if (n.uri && n.status === 'ok') files.add(n.uri);
          count(n.children);
        });
      count(includes);
      summary.textContent = files.size ? `Includes (${files.size} ${files.size === 1 ? 'file' : 'files'})` : 'Includes';

      const dirty = new Set(nav?.dirty ?? []);
      /** @type {IncludeNode | undefined} */
      const root = nav && {
        directive: '',
        target: fileName(nav.root),
        file: nav.root,
        line: -1,
        uri: nav.root,
        status: 'ok',
        children: includes,
      };
      tree.replaceChildren(list(root ? [root] : includes, nav?.shown, dirty), ...(includes.length ? [] : [empty()]));
      updateCrumbs(crumbs, root, nav, dirty);
    },
  };
}

function empty() {
  const p = document.createElement('p');
  p.className = 'pv-include-empty';
  p.textContent = 'This file includes no other files.';
  return p;
}

/**
 * @param {IncludeNode[]} nodes
 * @param {string | undefined} shownUri
 * @param {Set<string>} dirty
 */
function list(nodes, shownUri, dirty) {
  const ul = document.createElement('ul');
  for (const node of nodes) {
    const li = document.createElement('li');
    li.className = `pv-include pv-include-${node.status}${node.line < 0 ? ' pv-include-root' : ''}`;
    const row = document.createElement('div');
    row.className = 'pv-include-row';
    if (node.uri && node.uri === shownUri) row.classList.add('pv-include-shown');

    if (node.directive) {
      const directive = document.createElement('span');
      directive.className = 'pv-include-directive';
      directive.textContent = node.directive;
      row.append(directive);
    }

    const name = document.createElement(node.uri && node.status !== 'missing' ? 'a' : 'span');
    name.className = 'pv-include-target';
    name.textContent = node.target;
    if (name instanceof HTMLAnchorElement && node.uri) {
      name.dataset.uri = node.uri;
      name.title = `Show ${filePath(node.uri)} here`;
    }
    row.append(name);

    if (node.uri && dirty.has(node.uri)) {
      const dot = document.createElement('span');
      dot.className = 'pv-include-dirty';
      dot.textContent = '●';
      dot.title = 'Unsaved changes';
      row.append(dot);
    }

    if (node.line >= 0) {
      const line = document.createElement('a');
      line.className = 'pv-include-line';
      line.textContent = `:${node.line + 1}`;
      line.dataset.uri = node.file;
      line.dataset.line = String(node.line);
      line.title = `Show the directive (line ${node.line + 1} of ${fileName(node.file)})`;
      row.append(line);
    }

    const status = node.status === 'builtin' ? (node.target.startsWith('<') ? 'standard library' : 'URL, not loaded') : STATUS_TEXT[node.status];
    if (status) {
      const badge = document.createElement('span');
      badge.className = 'pv-include-status';
      badge.textContent = status;
      row.append(badge);
    }
    li.append(row);
    if (node.children.length) li.append(list(node.children, shownUri, dirty));
    ul.append(li);
  }
  return ul;
}

/**
 * Toolbar breadcrumbs from the root to the shown file, while it isn't the root.
 * @param {HTMLElement} crumbs
 * @param {IncludeNode | undefined} root
 * @param {Navigation | undefined} nav
 * @param {Set<string>} dirty
 */
function updateCrumbs(crumbs, root, nav, dirty) {
  crumbs.replaceChildren();
  if (!root || !nav || nav.shown === nav.root) return;
  const chain = findPath(root, nav.shown) ?? [root, { ...root, target: fileName(nav.shown), uri: nav.shown, children: [] }];
  chain.forEach((node, i) => {
    if (i > 0) crumbs.append(' › ');
    const last = i === chain.length - 1;
    const crumb = document.createElement(last ? 'span' : 'a');
    crumb.textContent = fileName(node.uri ?? '') + (node.uri && dirty.has(node.uri) ? ' ●' : '');
    if (!last && node.uri) {
      crumb.dataset.uri = node.uri;
      crumb.title = i === 0 ? 'Back to the file of this tab' : `Show ${fileName(node.uri)}`;
    }
    crumbs.append(crumb);
  });
  if (nav.rendered !== nav.shown) {
    // The preview shows another file: after a click in it, or for a fragment that doesn't render alone.
    const note = document.createElement('a');
    note.className = 'pv-crumbs-note';
    note.textContent = `(preview: ${fileName(nav.rendered)})`;
    note.dataset.uri = nav.shown;
    note.title = `The preview shows ${fileName(nav.rendered)} with your changes. Click to preview ${fileName(nav.shown)} on its own, if it can be.`;
    crumbs.append(' ', note);
  }
}

/**
 * The nodes from `node` down to the first one including `uri`.
 * @param {IncludeNode} node
 * @param {string} uri
 * @returns {IncludeNode[] | undefined}
 */
function findPath(node, uri) {
  if (node.uri === uri) return [node];
  for (const child of node.children) {
    const path = findPath(child, uri);
    if (path) return [node, ...path];
  }
  return undefined;
}

function fileName(/** @type {string} */ uri) {
  return decodeURIComponent(uri.split(/[\\/]/).pop() ?? uri);
}

function filePath(/** @type {string} */ uri) {
  return decodeURIComponent(uri.replace(/^file:\/\/\/?/, ''));
}
