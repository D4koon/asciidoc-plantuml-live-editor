import * as vscode from 'vscode';
import { IncludeNode, Origin, resolveIncludes } from './includes';
import { Version } from './versions';

/** One PlantUML diagram as the engine saw it, taken out of a document. */
export interface Diagram {
  /** The lines, from `@start…` to `@end…`, with includes expanded. */
  lines: string[];
  /** For each line, its Origin; null for a line the engine was given without it being written anywhere. */
  origins: (Origin | null)[];
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
  const lines = inlineIncludes ? resolved.lines : documentLines;
  const origins = inlineIncludes ? resolved.origins : documentLines.map((_, line) => ({ uri: document, line }));
  return { diagrams: cut(lines, origins), includes: resolved.includes };
}

/**
 * Splits lines into diagrams at their `@start…`/`@end…` markers, the way the
 * engine does: an unterminated diagram is closed, so something shows while
 * typing, and text without markers is one diagram.
 */
function cut(lines: string[], origins: (Origin | null)[]): Diagram[] {
  const diagrams: Diagram[] = [];
  /** Lines `from`..`to`, closed with `closingMarker` (an added line) when the text lacks one. */
  const diagram = (from: number, to: number, closingMarker?: string): Diagram => ({
    lines: [...lines.slice(from, to + 1), ...(closingMarker === undefined ? [] : [closingMarker])],
    origins: [...origins.slice(from, to + 1), ...(closingMarker === undefined ? [] : [null])],
  });

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
    });
  }
  return diagrams;
}
