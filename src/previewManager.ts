import * as path from 'path';
import * as vscode from 'vscode';
import { ElementRef, LineEdit, locateLine, planDelete, planRename } from './diagramEdits';
import { AsciiDocResult, AsciiDocSettings, isAsciiDoc, listAsciiDocIncludes, renderAsciiDoc } from './asciidoc';
import { Diagram, plantumlDiagrams } from './diagrams';
import { editBlock, editDiagram, Outcome } from './sourceEdits';
import { IncludeNode, resolveIncludes } from './includes';
import { fileKey, filePathOf, isReadOnly, Version } from './versions';
import { applyFileEdits, workspaceVersion } from './vscodeWorkspace';
import { DiffPairs, DiffSide } from './diffs';
import { DiffMessage, DiffScroll, FromWebview, NoDiffMessage, ToWebview, UpdateMessage } from './protocol';

interface PreviewState {
  uri: string;
}

const SPLIT_STATE_KEY = 'asciidocPlantumlLive.split';

class Preview implements vscode.Disposable, DiffSide {
  private updateTimer: ReturnType<typeof setTimeout> | undefined;
  private ready = false;
  // The panel's getters throw once it is disposed, so its state is mirrored here.
  private disposed = false;
  private active = false;
  private nextRequestId = 1;
  private readonly svgRequests = new Map<number, (svgs: string[]) => void>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly onDisposeEmitter = new vscode.EventEmitter<void>();
  readonly onDispose = this.onDisposeEmitter.event;
  private readonly onDidUpdateEmitter = new vscode.EventEmitter<void>();
  /** Fired after each render, once the files it includes are known. */
  readonly onDidUpdate = this.onDidUpdateEmitter.event;
  /** When the preview was opened, to pair the two sides of a diff. */
  readonly created = Date.now();
  private readonly onDidScrollEmitter = new vscode.EventEmitter<DiffScroll>();
  readonly onDidScroll = this.onDidScrollEmitter.event;
  /** The changes to show when this preview is a side of a diff. */
  private diff: DiffMessage | undefined;
  /** `asciidoc`: a whole document with embedded diagrams; `plantuml`: diagrams only. */
  readonly format: 'plantuml' | 'asciidoc';
  /** A version that can't be edited, e.g. the old side of a diff: no split view, no editing in the preview. */
  private readonly readOnly: boolean;

  // The tab always belongs to `uri` (the root). Navigating the overview of
  // includes shows another file in the tab: `shown` is the file in the split
  // view's editor, `rendered` the file the preview shows. They differ for
  // fragments (e.g. a file of skinparams), which are previewed through the root.
  private shown: vscode.Uri;
  private rendered: vscode.Uri;
  /** The files the last render read (the root's and the rendered file's includes); their changes re-render live. */
  private version: Version | undefined;
  /** Set while the editor was switched by a click in the preview: the file the preview keeps showing. */
  private keptPreview: vscode.Uri | undefined;
  /** Files other than the root edited in this tab, to remind about unsaved changes. */
  private readonly edited = new Set<string>();

  // Split view sync. Edits from the embedded editor are applied one at a time;
  // while any are pending, document changes are not echoed back to the webview.
  private editQueue: Promise<void> = Promise.resolve();
  private pendingEdits = 0;
  /** Version of the last embedded-editor edit applied to the document. */
  private appliedVersion = 0;
  /** The source text the webview is known to show. */
  private webviewSource: string | undefined;

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly uri: vscode.Uri,
    private readonly extensionUri: vscode.Uri,
    /** `editor`: the in-place custom editor; `panel`: a preview beside the text editor. */
    readonly kind: 'editor' | 'panel',
    private readonly globalState: vscode.Memento
  ) {
    const mediaRoot = vscode.Uri.joinPath(extensionUri, 'media');
    this.format = isAsciiDoc(uri) ? 'asciidoc' : 'plantuml';
    this.readOnly = isReadOnly(uri);
    this.shown = this.rendered = uri;
    // An AsciiDoc document may show images from its folder and the workspace.
    const documentRoots =
      this.format === 'asciidoc'
        ? [this.folder(), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)]
        : [];
    panel.webview.options = { enableScripts: true, localResourceRoots: [mediaRoot, ...documentRoots] };
    if (kind === 'panel') {
      panel.iconPath = vscode.Uri.joinPath(mediaRoot, 'icon.svg');
      panel.title = `Preview ${basename(uri)}`;
    }
    panel.webview.html = this.getHtml(panel.webview);

    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState(() => this.updateFocusContext()),
      panel.webview.onDidReceiveMessage((message: FromWebview) => this.onMessage(message))
    );
    this.updateFocusContext();
  }

  get isActive(): boolean {
    return this.active;
  }

  /** The URIs of the files shown: the tab's own and every file it includes. */
  files(): string[] {
    return [this.uri.toString(), this.rendered.toString(), ...(this.version?.files().map(String) ?? [])];
  }

  /** Shows the changes of this side of a diff (or, without `side`, no longer). */
  postDiff(message: DiffMessage | NoDiffMessage | DiffScroll): void {
    if (message.type === 'diff') this.diff = 'files' in message ? message : undefined;
    if (this.ready && !this.disposed) this.post(message);
  }

  /** Sends a message to the webview. */
  private post(message: ToWebview): void {
    void this.panel.webview.postMessage(message);
  }

  /** Whether a change to `uri` affects this preview. */
  dependsOn(uri: vscode.Uri): boolean {
    return fileKey(uri) === fileKey(this.uri) || fileKey(uri) === fileKey(this.shown) || !!this.version?.hasRead(uri);
  }

  scheduleUpdate(immediate = false): void {
    if (this.disposed) {
      return;
    }
    clearTimeout(this.updateTimer);
    const delay = immediate
      ? 0
      : vscode.workspace.getConfiguration('asciidocPlantumlLive').get<number>('renderDelay', 300);
    this.updateTimer = setTimeout(() => void this.update(), delay);
  }

  /** Called when this preview's own document changed. */
  documentChanged(immediate = false): void {
    void this.syncSource();
    this.scheduleUpdate(immediate);
  }

  /** Asks the webview for the SVG markup of every diagram currently rendered. */
  requestSvgs(): Promise<string[]> {
    const requestId = this.nextRequestId++;
    return new Promise((resolve) => {
      this.svgRequests.set(requestId, resolve);
      this.post({ type: 'requestSvg', requestId });
    });
  }

  private async update(): Promise<void> {
    if (!this.ready) {
      return;
    }
    const config = vscode.workspace.getConfiguration('asciidocPlantumlLive');
    const shown = this.shown;
    const version = workspaceVersion();
    const target = await this.renderTarget(shown, version);
    const format = isAsciiDoc(target) ? 'asciidoc' : 'plantuml';
    const text = await version.text(target);
    let content: Pick<UpdateMessage, 'diagrams' | 'html' | 'blocks' | 'titleBlock'>;
    let includes: IncludeNode[];
    if (format === 'asciidoc') {
      let result: AsciiDocResult;
      try {
        result = await renderAsciiDoc(text, target, version, asciiDocSettings());
      } catch (e) {
        result = {
          html: `<div class="pv-adoc-error">AsciiDoc conversion failed: ${String(e)}</div>`,
          diagrams: [],
          blocks: [],
          includes: [],
        };
      }
      const { html, diagrams, blocks, titleBlock } = result;
      content = { html, diagrams, blocks, titleBlock };
      includes = result.includes;
    } else {
      const inlineIncludes = config.get<boolean>('resolveIncludes', true);
      const result = await plantumlDiagrams(text, target, version, inlineIncludes);
      content = { diagrams: result.diagrams };
      includes = result.includes;
    }

    // The overview always shows the root's includes.
    const rootIncludes = target.toString() === this.uri.toString() ? includes : await this.listIncludes(this.uri, version);
    if (this.disposed || shown !== this.shown) {
      return; // closed, or navigated elsewhere, while the files were loading
    }
    this.version = version;
    this.rendered = target;
    const dirty = vscode.workspace.textDocuments.filter((d) => d.isDirty).map((d) => d.uri.toString());
    this.post({
      type: 'update',
      uri: this.uri.toString(),
      format,
      ...content,
      includes: rootIncludes,
      nav: { root: this.uri.toString(), shown: shown.toString(), rendered: target.toString(), dirty },
      theme: config.get<UpdateMessage['theme']>('theme', 'auto'),
    });
    this.onDidUpdateEmitter.fire();
  }

  /**
   * The file to preview while `shown` is in the editor: the file itself if it
   * renders on its own (an AsciiDoc file, or PlantUML with `@start…`),
   * otherwise the root, which shows the fragment's effect.
   */
  private async renderTarget(shown: vscode.Uri, version: Version): Promise<vscode.Uri> {
    if (this.keptPreview) {
      return this.keptPreview;
    }
    if (shown.toString() === this.uri.toString() || isAsciiDoc(shown)) {
      return shown;
    }
    try {
      return /^\s*@start\w+/m.test(await version.text(shown)) ? shown : this.uri;
    } catch {
      return this.uri;
    }
  }

  private async listIncludes(uri: vscode.Uri, version: Version): Promise<IncludeNode[]> {
    const text = await version.text(uri);
    return isAsciiDoc(uri)
      ? listAsciiDocIncludes(text, uri, version, asciiDocSettings())
      : (await resolveIncludes(text, uri, version)).includes;
  }

  /**
   * Shows another file of the include tree in this tab (the root stays the
   * tab's file), optionally selecting a line in the split view's editor.
   * With `keepPreview` (a click in the preview) only the editor changes and
   * the preview stays as it is; otherwise the preview follows the file.
   */
  private async show(uri: vscode.Uri, line: number | undefined, keepPreview = false): Promise<void> {
    const kept = keepPreview ? (this.keptPreview ?? this.rendered) : undefined;
    const previewChanges = kept?.toString() !== this.keptPreview?.toString();
    if (uri.toString() !== this.shown.toString()) {
      try {
        await vscode.workspace.openTextDocument(uri);
      } catch {
        void vscode.window.showWarningMessage(`Cannot open ${basename(uri)}.`);
        return;
      }
      this.shown = uri;
      this.keptPreview = kept;
      this.webviewSource = undefined;
      this.appliedVersion = 0; // the webview restarts its edit versions for the new file
      await this.syncSource();
      this.scheduleUpdate(true);
    } else if (previewChanges) {
      // E.g. the overview picks the file already in the editor: preview it now.
      this.keptPreview = kept;
      this.scheduleUpdate(true);
    }
    if (line !== undefined) {
      await this.revealLine(line, uri);
    }
  }

  /** Saves the file shown in the split view's editor (Ctrl+S in this tab). */
  async save(): Promise<void> {
    await (await vscode.workspace.openTextDocument(this.shown)).save();
  }

  /** Sends the shown file's text to the split view's embedded editor if it differs. */
  private async syncSource(): Promise<void> {
    if (this.kind !== 'editor' || !this.ready || this.pendingEdits > 0) {
      return;
    }
    const uri = this.shown;
    const document = await vscode.workspace.openTextDocument(uri);
    const text = document.getText();
    if (this.disposed || this.pendingEdits > 0 || uri !== this.shown || text === this.webviewSource) {
      return;
    }
    this.webviewSource = text;
    this.post({
      type: 'source',
      uri: uri.toString(),
      name: basename(uri),
      language: isAsciiDoc(uri) ? 'asciidoc' : 'plantuml',
      text,
      eol: document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n',
      // Lets the webview drop this if it has made edits we have not applied yet.
      ackVersion: this.appliedVersion,
    });
  }

  private enqueueEdit(message: Extract<FromWebview, { type: 'edit' }>): void {
    this.pendingEdits++;
    this.webviewSource = message.text;
    this.editQueue = this.editQueue
      .then(() => this.applyEdit(message))
      .catch((e) => {
        void vscode.window.showErrorMessage(`Could not apply the edit: ${e}`);
      })
      .finally(() => {
        this.pendingEdits--;
        if (this.pendingEdits === 0) {
          // Pick up any change made elsewhere while the edits were in flight.
          void this.syncSource();
        }
      });
  }

  private async applyEdit({ uri: target, version, changes, text }: Extract<FromWebview, { type: 'edit' }>): Promise<void> {
    // Edits name their file: ones still queued after navigating belong to the previous file.
    const uri = vscode.Uri.parse(target);
    const document = await vscode.workspace.openTextDocument(uri);
    const edit = new vscode.WorkspaceEdit();
    for (const change of changes) {
      const range = new vscode.Range(
        document.positionAt(change.offset),
        document.positionAt(change.offset + change.length)
      );
      edit.replace(uri, range, change.text);
    }
    await vscode.workspace.applyEdit(edit);
    if (document.getText() !== text) {
      // Out of sync (e.g. a concurrent change elsewhere): the embedded editor wins.
      const full = new vscode.WorkspaceEdit();
      full.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), text);
      await vscode.workspace.applyEdit(full);
    }
    if (target !== this.uri.toString()) {
      this.edited.add(target);
    }
    if (target === this.shown.toString()) {
      this.appliedVersion = version;
    }
  }

  /** The document's folder on disk; images of a git version come from the working copy. */
  private folder(): vscode.Uri {
    const file = filePathOf(this.uri);
    return file ? vscode.Uri.file(path.dirname(file)) : vscode.Uri.joinPath(this.uri, '..');
  }

  private onMessage(message: FromWebview): void {
    if (this.readOnly && ['edit', 'rename', 'delete', 'editBlock'].includes(message.type)) {
      return; // the webview offers no editing here; don't act on stray messages
    }
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.webviewSource = undefined;
        this.appliedVersion = 0; // a reloaded webview restarts its edit versions
        if (this.diff) this.post(this.diff);
        void this.syncSource();
        this.scheduleUpdate(true);
        break;
      case 'edit':
        this.enqueueEdit(message);
        break;
      case 'split':
        void this.globalState.update(SPLIT_STATE_KEY, message.split);
        break;
      case 'select':
        void this.revealElement(message.diagram, message.ref);
        break;
      case 'rename': {
        const { diagram, request } = message;
        void this.applyDiagramEdit(diagram, planRename(diagram.lines, request), `“${request.oldText}”`);
        break;
      }
      case 'delete':
        void this.applyDiagramEdit(message.diagram, planDelete(message.diagram.lines, message.ref), 'this connection');
        break;
      case 'revealLine':
        void this.revealSource(message.line, message.uri ? vscode.Uri.parse(message.uri) : this.rendered);
        break;
      case 'editBlock':
        void this.applyBlockEdit(message);
        break;
      case 'openLink':
        void this.openLink(message.href);
        break;
      case 'show':
        void this.show(vscode.Uri.parse(message.uri), message.line);
        break;
      case 'diffScroll':
        if (this.diff) this.onDidScrollEmitter.fire(message);
        break;
      case 'svg':
        this.svgRequests.get(message.requestId)?.(message.svgs);
        this.svgRequests.delete(message.requestId);
        break;
      case 'openSource':
        if (this.kind === 'editor') {
          void vscode.commands.executeCommand('asciidocPlantumlLive.editSource', this.shown);
        } else {
          void vscode.window.showTextDocument(this.uri, { viewColumn: vscode.ViewColumn.One });
        }
        break;
    }
  }

  /** Selects the source line of a clicked element, in whichever file it was written. */
  private async revealElement(diagram: Diagram, ref: ElementRef): Promise<void> {
    const line = locateLine(diagram.lines, ref);
    const origin = line === undefined ? undefined : diagram.origins[line];
    if (origin) {
      await this.revealSource(origin.line, vscode.Uri.parse(origin.uri));
    }
  }

  /**
   * Shows the source of something clicked in the preview: switches the split
   * view's editor to its file if it shows another one, and selects the line.
   */
  private async revealSource(line: number, uri: vscode.Uri): Promise<void> {
    if (this.kind === 'editor' && uri.toString() !== this.shown.toString()) {
      await this.show(uri, line, true);
    } else {
      await this.revealLine(line, uri);
    }
  }

  /**
   * Selects a line of `uri` (by default the previewed file) in the split
   * editor, if it shows that file, and in any visible text editor.
   */
  private async revealLine(line: number, uri = this.rendered): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    if (line >= document.lineCount || this.disposed) {
      return;
    }
    if (uri.toString() === this.shown.toString()) {
      this.post({ type: 'reveal', line });
    }
    const range = document.lineAt(line).range;
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === uri.toString()) {
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }
  }

  /** Opens a link clicked in an AsciiDoc preview: web links externally, relative ones in VS Code. */
  private async openLink(href: string): Promise<void> {
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    if (/^[a-z][\w+.-]*:/i.test(href)) {
      return; // other schemes (javascript:, file:, …) are ignored
    }
    const [target] = href.split('#');
    if (target) {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(this.uri, '..', decodeURIComponent(target)));
    }
  }

  /**
   * Replaces the lines of a block edited in the AsciiDoc preview. An empty
   * text removes the block. Refused if the lines changed since the preview
   * was rendered, since the edit would then land in the wrong place.
   */
  private async applyBlockEdit({ uri, ...block }: Extract<FromWebview, { type: 'editBlock' }>): Promise<void> {
    // Blocks of included files name their file.
    const outcome = await editBlock(uri ?? this.rendered.toString(), block, workspaceVersion());
    const changed = 'AsciiDoc: the document changed while you were editing. Please try again.';
    await this.apply(outcome, { notFound: changed, changed: () => changed });
  }

  private noteEdited(uri: vscode.Uri): void {
    if (uri.toString() !== this.uri.toString()) {
      this.edited.add(uri.toString());
    }
  }

  /** Applies a rename or delete planned on a diagram's lines; `what` names the target in messages. */
  private async applyDiagramEdit(diagram: Diagram, plan: LineEdit[] | undefined, what: string): Promise<void> {
    await this.apply(await editDiagram(diagram, plan, workspaceVersion()), {
      notFound: `PlantUML: couldn't find ${what} in the source. Edit it in the text editor instead.`,
      changed: (uri) => `PlantUML: ${basename(uri)} changed. Please try again.`,
    });
  }

  /** Applies the edits of `outcome`, or tells why there are none. */
  private async apply(outcome: Outcome, messages: { notFound: string; changed: (uri: vscode.Uri) => string }): Promise<void> {
    if (!outcome.ok) {
      const message = outcome.reason === 'changed' ? messages.changed(vscode.Uri.parse(outcome.uri)) : messages.notFound;
      void vscode.window.showInformationMessage(message);
      return;
    }
    await applyFileEdits(outcome.edits);
    new Set(outcome.edits.map((e) => e.uri)).forEach((uri) => this.noteEdited(vscode.Uri.parse(uri)));
  }

  private updateFocusContext(): void {
    this.active = this.panel.active;
    void vscode.commands.executeCommand('setContext', 'asciidocPlantumlLive.previewFocused', this.active);
  }

  private getHtml(webview: vscode.Webview): string {
    const media = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', ...parts));
    const nonce = createNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data: https:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource} data:`,
      // Viz.js compiles Graphviz from an embedded WebAssembly module.
      `script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'`,
      // Monaco's language worker is bootstrapped from a blob URL.
      `worker-src blob:`,
    ].join('; ');
    const split = this.globalState.get<boolean>(SPLIT_STATE_KEY, false);
    // Relative image paths in AsciiDoc resolve against the document's folder.
    const base =
      this.format === 'asciidoc' ? `\n  <base href="${webview.asWebviewUri(this.folder())}/">` : '';

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">${base}
  <link rel="stylesheet" href="${media('preview.css')}">
  <link rel="stylesheet" href="${media('asciidoc.css')}">
  <title>PlantUML Preview</title>
</head>
<body
  data-format="${this.format}"
  data-kind="${this.kind}"
  data-split="${split}"
  data-readonly="${this.readOnly}"
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

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    // Unregister first so a failure below can never leave a dead preview behind.
    this.onDisposeEmitter.fire();
    this.onDisposeEmitter.dispose();
    this.onDidUpdateEmitter.dispose();
    this.onDidScrollEmitter.dispose();

    clearTimeout(this.updateTimer);
    for (const resolve of this.svgRequests.values()) {
      resolve([]);
    }
    this.svgRequests.clear();
    if (this.active) {
      void vscode.commands.executeCommand('setContext', 'asciidocPlantumlLive.previewFocused', false);
    }
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose(); // no-op when VS Code already disposed it
    void remindUnsaved(this.edited);
  }
}

/**
 * Included files edited in a preview have no tab of their own; when the
 * preview closes, offers to save the ones that still have unsaved changes.
 */
async function remindUnsaved(uris: Set<string>): Promise<void> {
  const inTabs = new Set(
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) => (t.input instanceof vscode.TabInputText || t.input instanceof vscode.TabInputCustom ? t.input.uri.toString() : ''))
  );
  const unsaved = vscode.workspace.textDocuments.filter(
    (d) => d.isDirty && uris.has(d.uri.toString()) && !inTabs.has(d.uri.toString())
  );
  if (unsaved.length === 0) {
    return;
  }
  const names = unsaved.map((d) => basename(d.uri)).join(', ');
  const choice = await vscode.window.showWarningMessage(
    `${names} ${unsaved.length === 1 ? 'has' : 'have'} unsaved changes made in the preview.`,
    'Save',
    'Show'
  );
  if (choice === 'Save') {
    await Promise.all(unsaved.map((d) => d.save()));
  } else if (choice === 'Show') {
    for (const d of unsaved) {
      await vscode.window.showTextDocument(d, { preview: false });
    }
  }
}

export class PreviewManager
  implements vscode.WebviewPanelSerializer<PreviewState>, vscode.CustomTextEditorProvider, vscode.Disposable
{
  static readonly viewType = 'asciidocPlantumlLive.preview';

  private readonly previews = new Set<Preview>();
  private readonly diffs = new DiffPairs();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly globalState: vscode.Memento
  ) {
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e.document.uri)),
      vscode.workspace.onDidSaveTextDocument((d) => this.onDocumentChanged(d.uri, true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('asciidocPlantumlLive')) {
          this.previews.forEach((p) => p.scheduleUpdate(true));
        }
      })
    );
  }

  /** Opens (or reveals) a preview panel beside the text editor. */
  showBeside(document: vscode.TextDocument, column: vscode.ViewColumn): void {
    const key = document.uri.toString();
    const existing = [...this.previews].find((p) => p.kind === 'panel' && p.uri.toString() === key);
    if (existing) {
      existing.panel.reveal(column, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PreviewManager.viewType,
      `Preview ${basename(document.uri)}`,
      { viewColumn: column, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    this.track(new Preview(panel, document.uri, this.extensionUri, 'panel', this.globalState));
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: PreviewState | undefined): Promise<void> {
    if (!state?.uri) {
      panel.dispose();
      return;
    }
    this.track(new Preview(panel, vscode.Uri.parse(state.uri), this.extensionUri, 'panel', this.globalState));
  }

  /** Renders a PlantUML or AsciiDoc file in place when it is opened (the default editor for *.puml, *.adoc etc.). */
  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    this.track(new Preview(panel, document.uri, this.extensionUri, 'editor', this.globalState));
  }

  async exportSvg(): Promise<void> {
    const preview = this.activePreview();
    if (!preview) {
      vscode.window.showWarningMessage('Open a PlantUML preview first.');
      return;
    }
    const svgs = (await preview.requestSvgs()).filter((s) => s.length > 0);
    if (svgs.length === 0) {
      vscode.window.showWarningMessage('There is no rendered diagram to export.');
      return;
    }

    let index = 0;
    if (svgs.length > 1) {
      const pick = await vscode.window.showQuickPick(
        svgs.map((_, i) => ({ label: `Diagram ${i + 1}`, index: i })),
        { placeHolder: 'This file contains several diagrams — choose one to export' }
      );
      if (!pick) {
        return;
      }
      index = pick.index;
    }

    const suffix = svgs.length > 1 ? `-${index + 1}` : '';
    const defaultUri = preview.uri.with({
      path: preview.uri.path.replace(/(\.[^./]+)?$/, `${suffix}.svg`),
    });
    const target = await vscode.window.showSaveDialog({
      defaultUri: preview.uri.scheme === 'file' ? defaultUri : undefined,
      filters: { SVG: ['svg'] },
    });
    if (target) {
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(svgs[index]));
      vscode.window.showInformationMessage(`Saved ${basename(target)}`);
    }
  }

  dispose(): void {
    this.previews.forEach((p) => p.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  private track(preview: Preview): void {
    this.previews.add(preview);
    preview.onDispose(() => this.previews.delete(preview));
    this.diffs.add(preview, this.previews);
  }

  /** Saves the file shown in the active preview tab, which may be an included file. */
  async save(): Promise<void> {
    const preview = this.activePreview();
    if (preview?.isActive) {
      await preview.save();
    } else {
      await vscode.commands.executeCommand('workbench.action.files.save');
    }
  }

  private onDocumentChanged(uri: vscode.Uri, immediate = false): void {
    for (const preview of this.previews) {
      if (preview.dependsOn(uri)) {
        preview.documentChanged(immediate);
      } else if (uri.scheme === 'file' && immediate) {
        // A saved file may be pulled in by other previews through !include or include::.
        preview.scheduleUpdate(true);
      }
    }
  }

  private activePreview(): Preview | undefined {
    for (const preview of this.previews) {
      if (preview.isActive) {
        return preview;
      }
    }
    const editorUri = vscode.window.activeTextEditor?.document.uri.toString();
    return [...this.previews].find((p) => p.uri.toString() === editorUri);
  }
}

/** The AsciiDoc settings from the configuration. */
function asciiDocSettings(): AsciiDocSettings {
  const config = vscode.workspace.getConfiguration('asciidocPlantumlLive');
  return {
    safeMode: config.get<AsciiDocSettings['safeMode']>('asciidoc.safeMode', 'safe'),
    inlineIncludes: config.get<boolean>('resolveIncludes', true),
    defaultDir: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
  };
}

function basename(uri: vscode.Uri): string {
  return uri.path.split('/').pop() ?? uri.path;
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
