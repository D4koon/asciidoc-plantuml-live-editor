import * as vscode from 'vscode';
import { readText, relativeUri } from './versions';

const MAX_DEPTH = 16;
const INCLUDE_RE = /^(\s*)!include(_many|_once)?\s+(.+?)\s*$/;
const START_END_RE = /^\s*@(start|end)\w+/;

/**
 * The in-browser PlantUML engine has no file system access, so local
 * `!include` directives are inlined here before the text reaches the webview.
 * Standard-library (`<...>`) and URL includes are left for the engine.
 */
export async function resolveIncludes(text: string, baseUri: vscode.Uri): Promise<ResolvedText> {
  const includes: IncludeNode[] = [];
  const lines = await expand(text, baseUri, new Set([baseUri.toString()]), new Set(), 0, includes);
  const base = baseUri.toString();
  const files: string[] = [];
  const origins = lines.map((l): [number, number] => {
    let index = files.indexOf(l.file);
    if (index < 0) index = files.push(l.file) - 1;
    return [index, l.origin];
  });
  return {
    text: lines.map((l) => l.text).join('\n'),
    lineMap: lines.map((l) => (l.file === base ? l.origin : -1)),
    origins: { files, lines: origins },
    includes,
  };
}

export interface ResolvedText {
  text: string;
  /** For each line of `text`, its line in the original document, or -1 if it came from an include. */
  lineMap: number[];
  /** For each line of `text`, the file it came from (also for included lines). */
  origins: LineOrigins;
  /** The include directives of the text, with the ones nested in the included files. */
  includes: IncludeNode[];
}

/**
 * Where each line of a text came from: `lines[i]` is `[file, line]`, an
 * index into `files` (URIs) and a zero-based line there, or `[-1, -1]` for
 * lines added along the way (e.g. a synthesized `@startuml`).
 */
export interface LineOrigins {
  files: string[];
  lines: [number, number][];
}

/** The text of a document open in VS Code, unsaved changes included; undefined if it isn't open. */
export function openDocumentText(uri: vscode.Uri): string | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key)?.getText();
}

/** An include directive, for the split view's overview of included files. */
export interface IncludeNode {
  /** `!include` and its variants, AsciiDoc `include::`, or a `plantuml::` macro. */
  directive: string;
  /** The target as written. */
  target: string;
  /** The file containing the directive (a URI), and the directive's zero-based line in it. */
  file: string;
  line: number;
  /** The included file's URI, when it is a local file. */
  uri?: string;
  /**
   * `missing`: can't be read; `recursive`: already being included;
   * `once`: skipped by `!include_once`; `builtin`: standard library or URL,
   * left to the engine; `blocked`: outside the folder the safe mode allows.
   */
  status: 'ok' | 'missing' | 'recursive' | 'once' | 'builtin' | 'blocked';
  children: IncludeNode[];
}

interface Line {
  text: string;
  /** The file the line comes from (a URI), and its line number there. */
  file: string;
  origin: number;
}

async function expand(
  text: string,
  fileUri: vscode.Uri,
  stack: Set<string>,
  includedOnce: Set<string>,
  depth: number,
  includes: IncludeNode[]
): Promise<Line[]> {
  const out: Line[] = [];
  for (const [origin, line] of text.split(/\r\n|\r|\n/).entries()) {
    const match = INCLUDE_RE.exec(line);
    if (!match) {
      out.push({ text: line, file: fileUri.toString(), origin });
      continue;
    }

    const [, indent, variant, rawTarget] = match;
    const target = rawTarget.replace(/^"(.*)"$/, '$1');
    const node: IncludeNode = { directive: `!include${variant ?? ''}`, target, file: fileUri.toString(), line: origin, status: 'ok', children: [] };
    includes.push(node);
    if (target.startsWith('<') || /^[a-z]+:\/\//i.test(target) || fileUri.scheme === 'untitled') {
      node.status = fileUri.scheme === 'untitled' ? 'missing' : 'builtin';
      out.push({ text: line, file: fileUri.toString(), origin });
      continue;
    }

    // `file.puml!2` / `file.puml!id` selects a single diagram inside the file.
    const bang = target.lastIndexOf('!');
    const path = bang > 0 ? target.slice(0, bang) : target;
    const selector = bang > 0 ? target.slice(bang + 1) : undefined;

    const includeUri = relativeUri(fileUri, path);
    const key = includeUri.toString();
    node.uri = key;

    if (variant === '_once' && includedOnce.has(key)) {
      node.status = 'once';
      continue;
    }
    if (stack.has(key) || depth >= MAX_DEPTH) {
      node.status = 'recursive';
      out.push({ text: `${indent}' [asciidoc-plantuml-live-editor] skipped recursive include: ${target}`, file: fileUri.toString(), origin });
      continue;
    }

    let content: string;
    try {
      content = await readText(includeUri);
    } catch {
      // Leave the directive in place so the engine reports the missing file.
      node.status = 'missing';
      out.push({ text: line, file: fileUri.toString(), origin });
      continue;
    }
    includedOnce.add(key);

    stack.add(key);
    const selected = selectDiagram(content, selector);
    const expanded = await expand(selected.body, includeUri, stack, includedOnce, depth + 1, node.children);
    node.children.forEach((child) => (child.line += selected.offset));
    expanded.forEach((l) => l.file === key && (l.origin += selected.offset));
    stack.delete(key);
    out.push(...expanded.filter((l) => !START_END_RE.test(l.text)));
  }
  return out;
}

/**
 * Returns the body of one `@start...` block, chosen by index or
 * `@startuml(id=...)`, and the line of `content` where that body starts.
 */
function selectDiagram(content: string, selector: string | undefined): { body: string; offset: number } {
  if (selector === undefined) {
    return { body: content, offset: 0 };
  }
  const blocks: { id?: string; body: string[]; offset: number }[] = [];
  let current: { id?: string; body: string[]; offset: number } | undefined;
  for (const [i, line] of content.split(/\r\n|\r|\n/).entries()) {
    const start = /^\s*@start\w+(?:\s*\(\s*id\s*=\s*([^)]+?)\s*\))?/.exec(line);
    if (start) {
      current = { id: start[1], body: [], offset: i + 1 };
      continue;
    }
    if (/^\s*@end\w+/.test(line)) {
      if (current) {
        blocks.push(current);
      }
      current = undefined;
      continue;
    }
    current?.body.push(line);
  }
  const block = /^\d+$/.test(selector)
    ? blocks[Number(selector)]
    : blocks.find((b) => b.id === selector);
  return block ? { body: block.body.join('\n'), offset: block.offset } : { body: content, offset: 0 };
}
