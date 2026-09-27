import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { IncludeNode, LineOrigins, openDocumentText, resolveIncludes } from './includes';
import { filePathOf, readText, uriInVersion } from './versions';

// Asciidoctor.js 4 ships its own CommonJS build; its types target ESM resolution.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const asciidoctor: AsciidoctorModule = require('@asciidoctor/core');

interface AsciidoctorModule {
  load(input: string, options: object): Promise<AsciidoctorNode & { convert(): Promise<string> }>;
  Extensions: { create(): Registry };
}
interface AsciidoctorNode {
  context: string;
  level?: number;
  /** Source lines of a paragraph-like block (admonition labels stripped). */
  lines?: string[];
  parent?: AsciidoctorNode;
  /** Section title as written. */
  title?: string;
  getLineNumber(): number | undefined;
  getFile(): string | undefined | null;
  addRole(role: string): void;
  findBy(selector: object): AsciidoctorNode[];
}
interface Registry {
  block(fn: (this: BlockDsl) => void): void;
  blockMacro(fn: (this: MacroDsl) => void): void;
  includeProcessor(fn: (this: IncludeDsl) => void): void;
}
interface IncludeDsl {
  handles(fn: (doc: { reader?: PreprocessorReader }, target: string) => boolean): void;
  process(fn: (doc: unknown, reader: PreprocessorReader, target: string, attrs: Record<string, unknown>) => void): void;
}
/** Internals read to find the directive being processed: `_dir` is its folder, `_lines` holds it last. */
interface PreprocessorReader {
  _dir?: unknown;
  _lines?: unknown;
  pushInclude(data: string, file: string, path: string, lineno: number, attrs: Record<string, unknown>): void;
}
interface BlockDsl {
  named(name: string): void;
  onContexts(...contexts: string[]): void;
  process(fn: (parent: unknown, reader: Reader, attrs: Record<string, unknown>) => unknown): void;
  createPassBlock(parent: unknown, html: string, attrs: object): unknown;
}
interface MacroDsl {
  named(name: string): void;
  process(fn: (parent: unknown, target: string, attrs: Record<string, unknown>) => unknown): void;
  createPassBlock(parent: unknown, html: string, attrs: object): unknown;
}
interface Reader {
  getLines(): string[];
  getCursor(): { getLineNumber(): number; getFile(): string | undefined; getDirectory(): string | undefined };
}

export const ASCIIDOC_EXTENSIONS = /\.(adoc|asciidoc|asc)$/i;

export function isAsciiDoc(uri: vscode.Uri): boolean {
  return ASCIIDOC_EXTENSIONS.test(uri.path);
}

/** A PlantUML diagram found in an AsciiDoc document. */
export interface AsciiDocDiagram {
  /** Diagram text for the engine, starting at its `@start…` line. */
  source: string;
  /** For each line of `source`, its line in the document, or -1. */
  lineMap: number[];
  /** Document lines around the diagram (its delimiters); absent when read-only. */
  block?: { start: number; end: number };
  /** For each line of `source`, the file and line it came from (also included files). */
  origins?: LineOrigins;
  /** Set when the diagram could not be loaded (e.g. a missing `plantuml::` file). */
  error?: string;
}

/**
 * A block of the document that can be edited in the preview: its element
 * carries the role `pv-src-<index>`.
 */
export interface AsciiDocBlock {
  /** First and last document line (zero-based, inclusive). */
  start: number;
  end: number;
  /** The source of those lines when the preview was rendered. */
  text: string;
  /**
   * `line`: a title, edited as one line; `text`: may span lines; `none`: not
   * editable in the preview (tables, description lists), only located.
   */
  kind: 'line' | 'text' | 'none';
  /** The file the block is in (a URI), when it is not the document itself but an included file. */
  uri?: string;
}

export interface AsciiDocResult {
  html: string;
  diagrams: AsciiDocDiagram[];
  blocks: AsciiDocBlock[];
  /** Index into `blocks` of the document title (the `<h1>`), if editable. */
  titleBlock?: number;
  /** include:: directives, plantuml:: macros and diagram !includes, for the overview. */
  includes: IncludeNode[];
}

interface RawDiagram {
  lines: string[];
  /** File the diagram text came from, for resolving its `!include`s. */
  baseUri: vscode.Uri;
  /** Zero-based document line of the first content line; undefined if not in the document itself. */
  firstLine?: number;
  /** Zero-based line of the first content line in `baseUri`. */
  startLine: number;
  error?: string;
}

/**
 * Converts AsciiDoc to HTML with Asciidoctor.js. `[plantuml]` blocks and
 * `plantuml::file[]` macros become placeholders that the webview renders
 * with the PlantUML engine, like Asciidoctor Diagram would on the command line.
 */
export async function renderAsciiDoc(text: string, uri: vscode.Uri): Promise<AsciiDocResult> {
  const config = vscode.workspace.getConfiguration('asciidocPlantumlLive');
  const safeMode = config.get<string>('asciidoc.safeMode', 'safe');
  const docFile = filePathOf(uri);
  const docDir = docFile ? path.dirname(docFile) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  // A version from git (the old side of a diff) can't be edited, and its
  // includes come from the same version: read up front, since Asciidoctor
  // reads them synchronously.
  const isVersion = uri.scheme !== 'file' && !!docFile;
  const texts = new Map<string, string>();
  const includes = await collectIncludes(text, uri, docDir, safeMode !== 'unsafe', texts);
  const raw: RawDiagram[] = [];
  /** The placeholders standing in for diagrams; they are edited through the diagram instead. */
  const diagramBlocks = new Set<unknown>();

  const registry = asciidoctor.Extensions.create();
  registry.block(function () {
    this.named('plantuml');
    this.onContexts('listing', 'literal', 'open');
    this.process((parent, reader, attrs) => {
      const cursor = reader.getCursor();
      // Blocks of the document itself report `docfile` (or nothing); others come from include::.
      const file = cursor.getFile();
      const included = !!file && !(docFile && samePath(file, docFile));
      raw.push({
        lines: reader.getLines(),
        baseUri: included ? uriInVersion(uri, file) : uri,
        // The cursor is 1-based and points at the first content line.
        firstLine: included ? undefined : cursor.getLineNumber() - 1,
        startLine: cursor.getLineNumber() - 1,
      });
      const block = this.createPassBlock(parent, placeholder(raw.length - 1, attrs), {});
      diagramBlocks.add(block);
      return block;
    });
  });
  registry.blockMacro(function () {
    this.named('plantuml');
    this.process((parent, target, attrs) => {
      const file = docDir ? path.resolve(docDir, target) : undefined;
      let lines: string[] = [];
      let error: string | undefined;
      try {
        if (!file) throw new Error('no folder to resolve it against');
        const content = isVersion ? texts.get(fileKey(file)) : (openDocumentText(vscode.Uri.file(file)) ?? fs.readFileSync(file, 'utf8'));
        if (content === undefined) throw new Error('not found in this version');
        lines = content.split(/\r\n|\r|\n/);
      } catch (e) {
        error = `Cannot read plantuml::${target}[]: ${e instanceof Error ? e.message : e}`;
      }
      raw.push({ lines, baseUri: file ? uriInVersion(uri, file) : uri, startLine: 0, error });
      const block = this.createPassBlock(parent, placeholder(raw.length - 1, attrs), {});
      diagramBlocks.add(block);
      return block;
    });
  });

  // Included files with unsaved changes are read from the editor, so the
  // preview follows edits made in the split view before they are saved; a
  // version's includes come from that version. Includes selecting lines or
  // tags are left to Asciidoctor (saved text).
  const unsavedInclude = (reader: PreprocessorReader | undefined, target: string) => {
    const directive = Array.isArray(reader?._lines) ? String(reader._lines[reader._lines.length - 1]) : '';
    if (typeof reader?._dir !== 'string' || /\[.*\b(lines|tags?)\s*=/.test(directive)) return undefined;
    const file = path.resolve(reader._dir, target);
    if (safeMode !== 'unsafe' && docDir && !isWithin(file, docDir)) return undefined;
    if (isVersion) {
      const text = texts.get(fileKey(file));
      return text === undefined ? undefined : { file: file.split(path.sep).join('/'), text };
    }
    const document = vscode.workspace.textDocuments.find((d) => d.isDirty && d.uri.scheme === 'file' && samePath(d.uri.fsPath, file));
    return document && { file: file.split(path.sep).join('/'), text: document.getText() };
  };
  registry.includeProcessor(function () {
    this.handles((doc, target) => !!unsavedInclude(doc.reader, target));
    this.process((_doc, reader, target, attrs) => {
      const unsaved = unsavedInclude(reader, target);
      if (unsaved) reader.pushInclude(unsaved.text, unsaved.file, target, 1, attrs);
    });
  });

  const doc = await asciidoctor.load(text, {
    safe: safeMode,
    base_dir: docDir,
    standalone: false,
    sourcemap: true,
    extension_registry: registry,
    attributes: {
      showtitle: '',
      docdir: docDir ?? '',
      docfile: docFile ?? '',
      'asciidoc-plantuml-live-editor': '',
    },
  });
  // A version's blocks can't be edited, but they still show which lines changed in a diff.
  const readFile = (file: string) =>
    isVersion ? texts.get(fileKey(file)) : (openDocumentText(vscode.Uri.file(file)) ?? fs.readFileSync(file, 'utf8'));
  const { blocks, titleBlock } = tagEditableBlocks(doc, text.split(/\r\n|\r|\n/), docFile, diagramBlocks, readFile, (file) =>
    uriInVersion(uri, file).toString()
  );
  const html = await doc.convert();

  const inlineIncludes = config.get<boolean>('resolveIncludes', true);
  const diagrams: AsciiDocDiagram[] = [];
  for (const diagram of raw) {
    diagrams.push(
      diagram.error ? { source: '', lineMap: [], error: diagram.error } : await prepareDiagram(diagram, inlineIncludes)
    );
  }
  return { html, diagrams, blocks, titleBlock, includes };
}

/** The include tree of a document, without rendering it. */
export function listAsciiDocIncludes(text: string, uri: vscode.Uri): Promise<IncludeNode[]> {
  const safeMode = vscode.workspace.getConfiguration('asciidocPlantumlLive').get<string>('asciidoc.safeMode', 'safe');
  const docFile = filePathOf(uri);
  const docDir = docFile ? path.dirname(docFile) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return collectIncludes(text, uri, docDir, safeMode !== 'unsafe', new Map());
}

const INCLUDE_DIRECTIVE = /^include::([^\[\s][^\[]*)\[.*\]\s*$/;
const DIAGRAM_MACRO = /^plantuml::([^\[\s][^\[]*)\[.*\]\s*$/;
const DIAGRAM_BLOCK = /^\[plantuml\s*(,.*)?\]\s*$/;
const ATTRIBUTE_ENTRY = /^:([\w-]+):\s*(.*?)\s*$/;
const COMMENT_BLOCK = /^\/{4,}\s*$/;

/**
 * Lists what a document pulls in: include:: directives (followed into the
 * included files), plantuml:: macros, and the !includes of its diagrams.
 * Asciidoctor doesn't report includes, so the source is scanned the same
 * way it reads it; conditionals (ifdef::) are not evaluated. The text of
 * every file read is put in `texts` (by `fileKey`).
 */
async function collectIncludes(
  text: string,
  uri: vscode.Uri,
  docDir: string | undefined,
  jailed: boolean,
  texts: Map<string, string>
): Promise<IncludeNode[]> {
  const attributes = new Map([['docdir', docDir ?? '']]);

  const scan = async (text: string, fileUri: vscode.Uri, stack: Set<string>): Promise<IncludeNode[]> => {
    const nodes: IncludeNode[] = [];
    const lines = text.split(/\r\n|\r|\n/);
    const closing = (open: number) => {
      const close = lines.findIndex((l, i) => i > open && l.trim() === lines[open].trim());
      return close < 0 ? lines.length : close;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const attribute = ATTRIBUTE_ENTRY.exec(line);
      if (attribute) {
        attributes.set(attribute[1], attribute[2]);
        continue;
      }
      if (COMMENT_BLOCK.test(line)) {
        i = closing(i);
        continue;
      }
      if (DIAGRAM_BLOCK.test(line) && DELIMITER.test(lines[i + 1] ?? '')) {
        // A diagram's !includes resolve from the folder of the file it is written in.
        const close = closing(i + 1);
        const { includes } = await resolveIncludes(lines.slice(i + 2, close).join('\n'), fileUri);
        includes.forEach((node) => (node.line += i + 2));
        nodes.push(...includes);
        i = close;
        continue;
      }

      const include = INCLUDE_DIRECTIVE.exec(line);
      const macro = include ? undefined : DIAGRAM_MACRO.exec(line);
      const target = (include ?? macro)?.[1];
      if (!target) continue;
      const node: IncludeNode = {
        directive: include ? 'include::' : 'plantuml::',
        target,
        file: fileUri.toString(),
        line: i,
        status: 'ok',
        children: [],
      };
      nodes.push(node);

      const resolved = target.replace(/\{([\w-]+)\}/g, (m, name: string) => attributes.get(name) ?? m);
      if (/^[a-z][\w+.-]*:\/\//i.test(resolved)) {
        node.status = 'builtin';
        continue;
      }
      // include:: is relative to the including file; plantuml:: to the document (see the macro above).
      const including = filePathOf(fileUri);
      const base = include ? including && path.dirname(including) : docDir;
      if (!base) {
        node.status = 'missing';
        continue;
      }
      const file = path.resolve(base, resolved);
      const fileUriOfTarget = uriInVersion(uri, file);
      node.uri = fileUriOfTarget.toString();
      if (jailed && include && docDir && !isWithin(file, docDir)) {
        node.status = 'blocked';
        continue;
      }
      if (stack.has(node.uri) || stack.size > 16) {
        node.status = 'recursive';
        continue;
      }
      let content: string;
      try {
        content = await readText(fileUriOfTarget);
      } catch {
        node.status = 'missing';
        continue;
      }
      texts.set(fileKey(file), content);
      if (macro) {
        node.children = (await resolveIncludes(content, fileUriOfTarget)).includes;
      } else {
        stack.add(node.uri);
        node.children = await scan(content, fileUriOfTarget, stack);
        stack.delete(node.uri);
      }
    }
    return nodes;
  };

  return scan(text, uri, new Set([uri.toString()]));
}

const DELIMITER = /^(-{4,}|\.{4,})\s*$/;
const LIST_MARKER = /^\s*(\*+|-|\.+|\d+\.|[a-zA-Z]\.)\s/;
const BLOCK_START = /^(\+|\[.*\]|\/\/.*|-{4,}|\.{4,}|={4,}|\*{4,}|_{4,}|\|===.*)\s*$/;

/**
 * Finds the source lines of every editable block and tags it with a
 * `pv-src-<index>` role for the webview. Blocks of include:: files are
 * tagged with their file. Tables and description lists are left alone,
 * since their cells don't map onto whole lines.
 */
function tagEditableBlocks(
  doc: AsciidoctorNode,
  lines: string[],
  docFile: string | undefined,
  skip: Set<unknown>,
  readFile: (file: string) => string | undefined,
  uriOf: (file: string) => string
): { blocks: AsciiDocBlock[]; titleBlock?: number } {
  const blocks: AsciiDocBlock[] = [];
  let titleBlock: number | undefined;
  const isDocument = (file: string | undefined) => !file || (!!docFile && samePath(file, docFile));
  const fileLines = new Map<string, string[] | undefined>();
  /** The lines of the document or of an included file (with unsaved changes). */
  const linesOf = (file: string | undefined): string[] | undefined => {
    if (isDocument(file)) return lines;
    const key = path.resolve(file!);
    if (!fileLines.has(key)) {
      let text: string | undefined;
      try {
        text = readFile(key);
      } catch {
        text = undefined;
      }
      fileLines.set(key, text?.split(/\r\n|\r|\n/));
    }
    return fileLines.get(key);
  };
  const add = (node: AsciidoctorNode | undefined, file: string | undefined, { start, end, kind }: Span) => {
    node?.addRole(`pv-src-${blocks.length}`);
    const text = linesOf(file)!.slice(start, end + 1).join('\n');
    blocks.push({ start, end, text, kind, uri: isDocument(file) ? undefined : uriOf(file!) });
  };

  for (const node of doc.findBy({})) {
    const lineNumber = node.getLineNumber();
    if (!lineNumber || isInside(node, skip)) {
      continue;
    }
    const file = node.getFile() ?? undefined;
    const fileText = linesOf(file);
    if (!fileText) continue;
    if (node.context === 'section' && node.level === 0) {
      if (isDocument(file) && /^=\s/.test(fileText[lineNumber - 1] ?? '')) {
        // The document title: rendered as <h1> by the document, not the section.
        titleBlock = blocks.length;
        add(undefined, file, { start: lineNumber - 1, end: lineNumber - 1, kind: 'line' });
      }
      continue;
    }
    const span = measure(node, fileText, lineNumber - 1, false);
    if (span) {
      add(node, file, span);
      continue;
    }
    // A block starting right at an include:: is reported at the directive.
    const found = findInIncludes(node, file ?? docFile, fileText[lineNumber - 1] ?? '', linesOf, 0);
    if (found) add(node, found.file, found.span);
  }
  return { blocks, titleBlock };
}

interface Span {
  start: number;
  end: number;
  kind: AsciiDocBlock['kind'];
}

/**
 * The lines of `node` if it starts at `start` of `lines`, or undefined.
 * `strict` (searching for a block) also requires a section's title to match,
 * and skips blocks that can't be told apart by their first line.
 */
function measure(node: AsciidoctorNode, lines: string[], start: number, strict: boolean): Span | undefined {
  const line = lines[start] ?? '';
  switch (node.context) {
    case 'section':
      return /^(={2,6}|#{2,6})\s/.test(line) && (!strict || (!!node.title && line.includes(node.title)))
        ? { start, end: start, kind: 'line' }
        : undefined;
    case 'paragraph':
    case 'admonition':
    case 'literal':
    case 'listing': {
      if (DELIMITER.test(line)) {
        if (strict) return undefined;
        // Delimited block: edit the content between the delimiters.
        const close = lines.findIndex((l, i) => i > start && l.trim() === line.trim());
        return close > start + 1 ? { start: start + 1, end: close - 1, kind: 'text' } : undefined;
      }
      return node.lines?.length && line.includes(node.lines[0].trim())
        ? { start, end: start + node.lines.length - 1, kind: 'text' }
        : undefined;
    }
    case 'table': {
      // Cells don't map onto whole lines, so a table is only located (e.g. for diffs), not edited.
      if (strict || !/^\|={3,}\s*$/.test(line)) return undefined;
      const close = lines.findIndex((l, i) => i > start && l.trim() === line.trim());
      return { start, end: close < 0 ? lines.length - 1 : close, kind: 'none' };
    }
    case 'dlist': {
      if (strict || !line.trim()) return undefined;
      let end = start;
      while (end + 1 < lines.length && lines[end + 1].trim()) end++;
      return { start, end, kind: 'none' };
    }
    case 'list_item': {
      if (strict || node.parent?.context === 'dlist' || !LIST_MARKER.test(line)) return undefined;
      let end = start;
      while (end + 1 < lines.length && lines[end + 1].trim() && !LIST_MARKER.test(lines[end + 1]) && !BLOCK_START.test(lines[end + 1])) {
        end++;
      }
      return { start, end, kind: 'text' };
    }
  }
  return undefined;
}

/** Looks for `node` in the file an include:: `directive` pulls in, and the files it includes. */
function findInIncludes(
  node: AsciidoctorNode,
  file: string | undefined,
  directive: string,
  linesOf: (file: string) => string[] | undefined,
  depth: number
): { file: string; span: Span } | undefined {
  const target = INCLUDE_DIRECTIVE.exec(directive)?.[1];
  if (!target || !file || depth > 3 || /\{/.test(target)) return undefined;
  const included = path.resolve(path.dirname(file), target);
  const lines = linesOf(included);
  if (!lines) return undefined;
  for (let i = 0; i < lines.length; i++) {
    const span = measure(node, lines, i, true);
    if (span) return { file: included, span };
  }
  for (const line of lines) {
    const found = INCLUDE_DIRECTIVE.test(line) && findInIncludes(node, included, line, linesOf, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Resolves includes and trims/wraps the text so it starts at `@start…`. */
async function prepareDiagram(
  { lines, baseUri, firstLine, startLine }: RawDiagram,
  inlineIncludes: boolean
): Promise<AsciiDocDiagram> {
  const base = baseUri.toString();
  const resolved = inlineIncludes
    ? await resolveIncludes(lines.join('\n'), baseUri)
    : { text: lines.join('\n'), lineMap: lines.map((_, i) => i), origins: { files: [base], lines: lines.map((_, i): [number, number] => [0, i]) } };
  let source = resolved.text.split('\n');
  let lineMap = resolved.lineMap.map((i) => (i < 0 || firstLine === undefined ? -1 : firstLine + i));
  // Lines of the block itself are counted from its first line; included files from their start.
  const baseIndex = resolved.origins.files.indexOf(base);
  let origins = resolved.origins.lines.map(([f, l]): [number, number] => [f, f === baseIndex ? l + startLine : l]);
  const none: [number, number] = [-1, -1];

  const start = source.findIndex((l) => /^\s*@start\w+/.test(l));
  if (start < 0) {
    // Asciidoctor Diagram allows omitting @startuml/@enduml.
    source = ['@startuml', ...source, '@enduml'];
    lineMap = [-1, ...lineMap, -1];
    origins = [none, ...origins, none];
  } else {
    let end = source.findIndex((l, i) => i > start && /^\s*@end\w+/.test(l));
    if (end < 0) {
      source.push('@enduml');
      lineMap.push(-1);
      origins.push(none);
      end = source.length - 1;
    }
    source = source.slice(start, end + 1);
    lineMap = lineMap.slice(start, end + 1);
    origins = origins.slice(start, end + 1);
  }

  return {
    source: source.join('\n'),
    lineMap,
    origins: { files: resolved.origins.files, lines: origins },
    block: firstLine === undefined ? undefined : { start: firstLine - 1, end: firstLine + lines.length },
  };
}

function placeholder(index: number, attrs: Record<string, unknown>): string {
  const id = typeof attrs.id === 'string' ? ` id="${escapeHtml(attrs.id)}"` : '';
  const title = typeof attrs.title === 'string' ? `\n<div class="title">${escapeHtml(attrs.title)}</div>` : '';
  return `<div${id} class="imageblock pv-adoc-diagram-block">
<div class="content"><div class="diagram pv-adoc-diagram" data-diagram="${index}"></div></div>${title}
</div>`;
}

/** Whether `node` or one of its ancestors is in `nodes` (Asciidoctor.js parents unused block content to the block). */
function isInside(node: AsciidoctorNode, nodes: Set<unknown>): boolean {
  // The document is its own parent, so stop there.
  for (let n: AsciidoctorNode | undefined = node; n && n.context !== 'document'; n = n.parent) {
    if (nodes.has(n)) return true;
  }
  return false;
}

function samePath(a: string, b: string): boolean {
  return fileKey(a) === fileKey(b);
}

/** A file path normalized for comparison (Windows paths ignore case). */
function fileKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isWithin(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
