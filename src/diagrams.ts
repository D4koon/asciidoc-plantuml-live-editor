import * as vscode from 'vscode';
import { IncludeNode, LineOrigins, resolveIncludes } from './includes';
import { Version } from './versions';

/** The file (a URI) and zero-based line, within a Version, that a line of a Diagram came from. */
export interface Origin {
  uri: string;
  line: number;
}

/** One PlantUML diagram as the engine saw it, taken out of a document. */
export interface Diagram {
  /** The lines, from `@start…` to `@end…`, with includes expanded. */
  lines: string[];
  /** For each line, its Origin; null for a line the engine was given without it being written anywhere. */
  origins: (Origin | null)[];
  /**
   * The document lines enclosing the lines the diagram is written in: its
   * `@start…`/`@end…` lines, or an AsciiDoc block's delimiters; -1 and the
   * document's length when the markers were added. Absent when it isn't
   * written in the document itself (e.g. it comes from an included file).
   */
  block?: { start: number; end: number };
  /** Set when the diagram could not be loaded (e.g. a missing `plantuml::` file). */
  error?: string;
}

/**
 * The Diagrams of a PlantUML file, cut out of its text with includes
 * expanded (unless `inlineIncludes` is off), and its include directives.
 */
export async function plantumlDiagrams(
  text: string,
  uri: vscode.Uri,
  version: Version,
  inlineIncludes = true
): Promise<{ diagrams: Diagram[]; includes: IncludeNode[] }> {
  // Resolved even when not inlined, for the split view's overview of includes.
  const resolved = await resolveIncludes(text, uri, version);
  const document = uri.toString();
  const documentLines = text.split(/\r\n|\r|\n/);
  const lines = inlineIncludes ? resolved.text.split('\n') : documentLines;
  const origins = inlineIncludes ? originsOf(resolved.origins) : documentLines.map((_, line) => ({ uri: document, line }));
  return { diagrams: cut(lines, origins, document, documentLines.length), includes: resolved.includes };
}

/** The Diagram of a diagram found in an AsciiDoc document (as `renderAsciiDoc` prepares it for the engine). */
export function fromAsciiDoc(diagram: {
  source: string;
  origins?: LineOrigins;
  block?: { start: number; end: number };
  error?: string;
}): Diagram {
  if (diagram.error !== undefined) {
    return { lines: [], origins: [], error: diagram.error };
  }
  if (!diagram.origins) throw new Error('A diagram without an error must have its origins');
  return {
    lines: diagram.source.split('\n'),
    origins: originsOf(diagram.origins),
    ...(diagram.block ? { block: diagram.block } : {}),
  };
}

/** Converts what include resolution reports, a file index and line per line, into Origins. */
export function originsOf({ files, lines }: LineOrigins): (Origin | null)[] {
  return lines.map(([file, line]) => (file >= 0 ? { uri: files[file], line } : null));
}

/**
 * Splits lines into diagrams at their `@start…`/`@end…` markers, the way the
 * engine does: an unterminated diagram is closed, so something shows while
 * typing, and text without markers is one diagram.
 */
function cut(lines: string[], origins: (Origin | null)[], document: string, documentLength: number): Diagram[] {
  const diagrams: Diagram[] = [];
  const documentLine = (i: number) => (origins[i]?.uri === document ? origins[i]!.line : undefined);
  /** Lines `from`..`to`, closed with `closingMarker` (an added line) when the text lacks one. */
  const diagram = (from: number, to: number, closingMarker?: string): Diagram => {
    const start = documentLine(from);
    const last = closingMarker === undefined ? documentLine(to) : documentLength;
    return {
      lines: [...lines.slice(from, to + 1), ...(closingMarker === undefined ? [] : [closingMarker])],
      origins: [...origins.slice(from, to + 1), ...(closingMarker === undefined ? [] : [null])],
      ...(start !== undefined && last !== undefined ? { block: { start, end: last } } : {}),
    };
  };

  let start = -1;
  let kind = '';
  lines.forEach((line, i) => {
    const s = /^\s*@start(\w+)/.exec(line);
    if (s && start < 0) {
      start = i;
      kind = s[1];
      return;
    }
    const e = /^\s*@end(\w+)/.exec(line);
    if (e && start >= 0 && e[1] === kind) {
      diagrams.push(diagram(start, i));
      start = -1;
    }
  });
  if (start >= 0) {
    diagrams.push(diagram(start, lines.length - 1, `@end${kind}`));
  }
  if (diagrams.length === 0 && lines.join('\n').trim().length > 0) {
    diagrams.push({
      lines: ['@startuml', ...lines, '@enduml'],
      origins: [null, ...origins, null],
      block: { start: -1, end: documentLength },
    });
  }
  return diagrams;
}
