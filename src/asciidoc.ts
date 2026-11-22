import * as path from 'path';
import * as vscode from 'vscode';
import { Diagram, Origin } from './diagrams';
import { IncludeNode, resolveIncludes } from './includes';
import { selectFrom } from './includeSelection';
import { fileKey, filePathOf, samePath, uriInVersion, Version } from './versions';

// Asciidoctor.js 4 ships its own CommonJS build; its types target ESM resolution.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const asciidoctor: AsciidoctorModule = require('@asciidoctor/core');

interface AsciidoctorModule {
  load(input: string, options: object): Promise<AsciidoctorNode & { convert(): Promise<string> }>;
  Extensions: { create(): Registry };
  MemoryLogger: new () => MemoryLogger;
}
/** Collects what Asciidoctor logs while loading and converting a document. */
interface MemoryLogger {
  getMessages(): { getSeverity(): string; getText(): string; getSourceLocation(): SourceLocation | undefined }[];
  warn(message: { text: string; source_location: SourceLocation }): void;
}
interface SourceLocation {
  getFile(): string | undefined | null;
  getLineNumber(): number | undefined;
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
  handles(fn: (doc: { reader?: PreprocessorReader; getAttribute(name: string): unknown }, target: string) => boolean): void;
  process(fn: (doc: unknown, reader: PreprocessorReader, target: string, attrs: Record<string, unknown>) => void): void;
}
/**
 * Internals read to find the directive being processed: `_dir` is its folder,
 * `_lines` holds it last (until it is processed), `file` and `lineno` the line after it.
 */
interface PreprocessorReader {
  _dir?: unknown;
  _lines?: unknown;
  file?: string | null;
  lineno: number;
  includeDepth: number;
  pushInclude(data: string | string[], file: string, path: string, lineno: number, attrs: Record<string, unknown>): void;
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

/** The settings AsciiDoc rendering depends on (read from the configuration by the caller). */
export interface AsciiDocSettings {
  /** Asciidoctor's safe mode. */
  safeMode: 'unsafe' | 'safe' | 'server' | 'secure';
  /** Whether diagrams' `!include`s are inlined before they reach the engine. */
  inlineIncludes: boolean;
  /** The folder to resolve paths against when the document has none (e.g. untitled). */
  defaultDir?: string;
}

/** A problem Asciidoctor reported while rendering the document. */
export interface Warning {
  severity: 'warning' | 'error';
  /** In Asciidoctor's words. */
  text: string;
  /** The file it concerns (a URI), and the line (zero-based) if known. */
  uri: string;
  line?: number;
}

export interface AsciiDocResult {
  html: string;
  /**
   * What Asciidoctor reported, in order. Those of an include:: selecting lines
   * or tags also have a box where the include is (`pv-warning`, `data-warning`: the index).
   */
  warnings: Warning[];
  /** The document's diagrams, in the order of their placeholders (`data-diagram`). */
  diagrams: Diagram[];
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
  /** The line (zero-based) of `baseUri` that line `index` of the diagram is, if any. */
  lineOf(index: number): number | null;
  error?: string;
}

/**
 * Converts AsciiDoc to HTML with Asciidoctor.js. `[plantuml]` blocks and
 * `plantuml::file[]` macros become placeholders that the webview renders
 * with the PlantUML engine, like Asciidoctor Diagram would on the command line.
 */
export async function renderAsciiDoc(
  text: string,
  uri: vscode.Uri,
  version: Version,
  { safeMode, inlineIncludes, defaultDir }: AsciiDocSettings
): Promise<AsciiDocResult> {
  const docFile = filePathOf(uri);
  const docDir = docFile ? path.dirname(docFile) : defaultDir;
  // Asciidoctor reads synchronously, which a version from git (the old side
  // of a diff) can't: collecting the includes reads them up front.
  const includes = await collectIncludes(text, uri, docDir, safeMode !== 'unsafe', version);
  /** The text of `file` in the document's version, or undefined. */
  const readFile = (file: string) => version.textSync(uriInVersion(uri, file));
  const raw: RawDiagram[] = [];
  const selections = new Selections();
  const logger = new asciidoctor.MemoryLogger();
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
      // The cursor is 1-based and points at the first content line.
      const first = cursor.getLineNumber();
      raw.push({
        lines: reader.getLines(),
        baseUri: included ? uriInVersion(uri, file) : uri,
        lineOf: (index) => selections.line(file, first + index),
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
        const content = readFile(file);
        if (content === undefined) throw new Error('not found');
        lines = content.split(/\r\n|\r|\n/);
      } catch (e) {
        error = `Cannot read plantuml::${target}[]: ${e instanceof Error ? e.message : e}`;
      }
      raw.push({ lines, baseUri: file ? uriInVersion(uri, file) : uri, lineOf: (index) => index, error });
      const block = this.createPassBlock(parent, placeholder(raw.length - 1, attrs), {});
      diagramBlocks.add(block);
      return block;
    });
  });

  // Included files open in an editor are read from it, so the preview follows
  // edits made in the split view before they are saved, and a git version's
  // includes come from that version. Other files Asciidoctor reads itself
  // (the same text), except those selecting lines or tags: selecting moves
  // lines, which the preview maps back to the file (see Selections).
  const versionInclude = (reader: PreprocessorReader | undefined, target: string, selecting: boolean, maxDepth: number) => {
    if (typeof reader?._dir !== 'string' || reader.includeDepth >= maxDepth) return undefined;
    const file = path.resolve(reader._dir, target);
    if (safeMode !== 'unsafe' && docDir && !isWithin(file, docDir)) return undefined;
    const fileUri = uriInVersion(uri, file);
    if (!selecting && fileUri.scheme === 'file' && !version.isOpen(fileUri)) return undefined;
    const text = version.textSync(fileUri);
    return text === undefined ? undefined : { file: file.split(path.sep).join('/'), text };
  };
  /** The number of warnings shown so far: the index of the next one. */
  const shown = () => logger.getMessages().filter((m) => SEVERITIES[m.getSeverity()]).length;
  registry.includeProcessor(function () {
    this.handles((doc, target) => {
      const lines = doc.reader?._lines;
      const directive = Array.isArray(lines) ? String(lines[lines.length - 1]) : '';
      return !!versionInclude(doc.reader, target, SELECTING.test(directive), maxIncludeDepth(doc));
    });
    this.process((_doc, reader, target, attrs) => {
      // `handles` has checked the rest.
      const include = versionInclude(reader, target, true, Infinity);
      if (!include) return;
      const selected = selectFrom(include.text, attrs, include.file);
      if (!selected) {
        reader.pushInclude(include.text, include.file, target, 1, attrs);
        return;
      }
      if (selected.partial) attrs['partial-option'] = '';
      // Problems belong to the directive, which the reader has just passed; each gets a box in its place.
      const directive = { file: reader.file, line: reader.lineno - 1 };
      const at: SourceLocation = { getFile: () => directive.file, getLineNumber: () => directive.line };
      const boxes = selected.warnings.map((text) => {
        const index = shown();
        logger.warn({ text, source_location: at });
        return `<div class="pv-warning" data-warning="${index}"></div>\n`;
      });
      const box = boxes.length > 0 ? ['++++\n', ...boxes, '++++\n'] : [];
      const lines = [...box, ...selected.lines];
      if (lines.length === 0) return;
      const first = selections.add(include.file, lines, [...box.map(() => null), ...selected.fileLines]);
      reader.pushInclude(lines, include.file, target, first, attrs);
    });
  });

  const doc = await asciidoctor.load(text, {
    safe: safeMode,
    base_dir: docDir,
    standalone: false,
    sourcemap: true,
    extension_registry: registry,
    logger,
    attributes: {
      showtitle: '',
      docdir: docDir ?? '',
      docfile: docFile ?? '',
      'asciidoc-plantuml-live-editor': '',
    },
  });
  // A version's blocks can't be edited, but they still show which lines changed in a diff.
  const isDocument = (file: string | undefined | null) => !file || (!!docFile && samePath(file, docFile));
  const uriOf = (file: string | undefined | null) => (isDocument(file) ? uri : uriInVersion(uri, file!)).toString();
  const { blocks, titleBlock } = tagEditableBlocks(doc, text.split(/\r\n|\r|\n/), docFile, diagramBlocks, readFile, uriOf, selections);
  const html = await doc.convert();
  const warnings = logger.getMessages().flatMap((message): Warning[] => {
    const severity = SEVERITIES[message.getSeverity()];
    if (!severity) return [];
    const at = message.getSourceLocation();
    const file = at?.getFile();
    const lineno = at?.getLineNumber();
    const line = lineno ? selections.line(file, lineno) : null;
    return [{ severity, text: message.getText(), uri: uriOf(file), ...(line === null ? {} : { line }) }];
  });

  const diagrams: Diagram[] = [];
  for (const diagram of raw) {
    diagrams.push(await toDiagram(diagram, inlineIncludes, version));
  }
  return { html, warnings, diagrams, blocks, titleBlock, includes };
}

/** An include:: directive selecting lines or tags. */
const SELECTING = /\[.*\b(lines|tags?)\s*=/;

/** What the preview shows of Asciidoctor's log levels (DEBUG and INFO are left out). */
const SEVERITIES: Record<string, Warning['severity'] | undefined> = { WARN: 'warning', ERROR: 'error', FATAL: 'error' };

/** How deep includes may nest before Asciidoctor stops (it then reports it). */
function maxIncludeDepth(doc: { getAttribute(name: string): unknown }): number {
  const depth = parseInt(String(doc.getAttribute('max-include-depth') ?? ''), 10);
  return Number.isNaN(depth) ? 64 : depth;
}

/** Selected include lines are numbered from multiples of this, beyond any real line. */
const SELECTION_LINES = 10_000_000;

interface Pushed {
  file: string;
  /** The line number Asciidoctor reports for the first line. */
  first: number;
  /** The lines as pushed, without line endings. */
  lines: string[];
  /** For each line, its line in the file (zero-based), or null for a line the preview added. */
  fileLines: (number | null)[];
}

/**
 * The lines that include:: directives selecting lines or tags pushed.
 * Asciidoctor numbers pushed lines one after another, but a selection skips
 * lines (and a file may be included with several selections), so each
 * selection is numbered from its own far-off line and mapped back to the file.
 */
class Selections {
  private readonly pushed: Pushed[] = [];

  /** Records `lines` pushed for `file`; returns the line number to push them at. */
  add(file: string, lines: string[], fileLines: (number | null)[]): number {
    const first = (this.pushed.length + 1) * SELECTION_LINES;
    this.pushed.push({ file, first, lines: lines.map((l) => l.replace(/\r?\n$/, '')), fileLines });
    return first;
  }

  /** The selection that line `lineno` (one-based, as Asciidoctor reports it) of `file` is in, and its index there. */
  find(file: string | undefined | null, lineno: number): { pushed: Pushed; index: number } | undefined {
    if (!file || lineno < SELECTION_LINES) return undefined;
    const pushed = this.pushed.find((p) => lineno >= p.first && lineno < p.first + p.lines.length && samePath(p.file, file));
    return pushed && { pushed, index: lineno - pushed.first };
  }

  /** The line (zero-based) of `file` that Asciidoctor reports as `lineno`; null for a line the preview added. */
  line(file: string | undefined | null, lineno: number): number | null {
    const found = this.find(file, lineno);
    return found ? found.pushed.fileLines[found.index] : lineno - 1;
  }
}

/** The include tree of a document, without rendering it. */
export function listAsciiDocIncludes(
  text: string,
  uri: vscode.Uri,
  version: Version,
  { safeMode, defaultDir }: AsciiDocSettings
): Promise<IncludeNode[]> {
  const docFile = filePathOf(uri);
  const docDir = docFile ? path.dirname(docFile) : defaultDir;
  return collectIncludes(text, uri, docDir, safeMode !== 'unsafe', version);
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
 * way it reads it; conditionals (ifdef::) are not evaluated. Every file is
 * read through `version`, so it can then be read synchronously.
 */
async function collectIncludes(
  text: string,
  uri: vscode.Uri,
  docDir: string | undefined,
  jailed: boolean,
  version: Version
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
        const { includes } = await resolveIncludes(lines.slice(i + 2, close).join('\n'), fileUri, version);
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
      if (stack.has(fileKey(fileUriOfTarget)) || stack.size > 16) {
        node.status = 'recursive';
        continue;
      }
      let content: string;
      try {
        content = await version.text(fileUriOfTarget);
      } catch {
        node.status = 'missing';
        continue;
      }
      if (macro) {
        node.children = (await resolveIncludes(content, fileUriOfTarget, version)).includes;
      } else {
        stack.add(fileKey(fileUriOfTarget));
        node.children = await scan(content, fileUriOfTarget, stack);
        stack.delete(fileKey(fileUriOfTarget));
      }
    }
    return nodes;
  };

  return scan(text, uri, new Set([fileKey(uri)]));
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
  uriOf: (file: string | undefined) => string,
  selections: Selections
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
    blocks.push({ start, end, text, kind, uri: isDocument(file) ? undefined : uriOf(file) });
  };

  for (const node of doc.findBy({})) {
    const lineNumber = node.getLineNumber();
    if (!lineNumber || isInside(node, skip)) {
      continue;
    }
    const file = node.getFile() ?? undefined;
    const selected = selections.find(file, lineNumber);
    if (selected) {
      // Measured in the selected lines, as Asciidoctor read them.
      const span = measure(node, selected.pushed.lines, selected.index, false);
      const inFile = span && inFileOf(span, selected.pushed.fileLines);
      if (inFile) add(node, file, inFile);
      continue;
    }
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
 * The lines of the file that `span` of selected lines is (`fileLines`: the
 * line of each). A block spanning lines the selection skipped is only located:
 * editing it would replace lines the preview doesn't show.
 */
function inFileOf(span: Span, fileLines: (number | null)[]): Span | undefined {
  const start = fileLines[span.start];
  const end = fileLines[span.end];
  if (start == null || end == null) return undefined;
  const together = fileLines.slice(span.start, span.end + 1).every((line, i) => line === start + i);
  return { start, end, kind: together ? span.kind : 'none' };
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

/** The Diagram of a block or macro: includes resolved, trimmed or wrapped to start at `@start…`. */
async function toDiagram({ lines, baseUri, lineOf, error }: RawDiagram, inlineIncludes: boolean, version: Version): Promise<Diagram> {
  if (error !== undefined) return { lines: [], origins: [], error };
  const base = baseUri.toString();
  const resolved = inlineIncludes
    ? await resolveIncludes(lines.join('\n'), baseUri, version)
    : { lines, origins: lines.map((_, line) => ({ uri: base, line })) };
  let source = resolved.lines;
  // Lines of the block itself are counted from its first line; included files from their start.
  let origins: (Origin | null)[] = resolved.origins.map((o) => {
    if (o.uri !== base) return o;
    const line = lineOf(o.line);
    return line === null ? null : { uri: base, line };
  });

  const start = source.findIndex((l) => /^\s*@start\w+/.test(l));
  if (start < 0) {
    // Asciidoctor Diagram allows omitting @startuml/@enduml.
    source = ['@startuml', ...source, '@enduml'];
    origins = [null, ...origins, null];
  } else {
    let end = source.findIndex((l, i) => i > start && /^\s*@end\w+/.test(l));
    if (end < 0) {
      source = [...source, '@enduml'];
      origins = [...origins, null];
      end = source.length - 1;
    }
    source = source.slice(start, end + 1);
    origins = origins.slice(start, end + 1);
  }
  return { lines: source, origins };
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

function isWithin(file: string, dir: string): boolean {
  const relative = path.relative(dir, file);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
