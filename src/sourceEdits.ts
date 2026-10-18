import * as vscode from 'vscode';
import { LineEdit } from './diagramEdits';
import { Diagram } from './diagrams';
import { Version } from './versions';

/**
 * Turns edits made in the preview into text edits of the files they belong
 * to. A diagram's edits are planned on its lines as the engine saw them and
 * land in whichever file each line came from (its Origin). An edit is made
 * entirely or not at all: it is refused if a line has no Origin, or if a
 * file no longer has the text the preview showed.
 */

/** A position in a file (zero-based). */
export interface FilePosition {
  line: number;
  character: number;
}

/** Replaces the text from `start` to `end` of the file `uri` with `text`. */
export interface FileEdit {
  uri: string;
  start: FilePosition;
  end: FilePosition;
  text: string;
}

export type Outcome =
  | { ok: true; edits: FileEdit[] }
  /** The plan found nothing to edit, or something to edit that isn't written anywhere. */
  | { ok: false; reason: 'not-found' }
  /** `uri` changed since the preview was rendered. */
  | { ok: false; reason: 'changed'; uri: string };

/** Applies `plan` (edits of `diagram`'s lines) to the files the lines came from. */
export async function editDiagram(
  diagram: Diagram,
  plan: LineEdit[] | undefined,
  version: Version
): Promise<Outcome> {
  if (!plan || plan.some(({ line }) => !diagram.origins[line])) {
    return { ok: false, reason: 'not-found' };
  }
  const byFile = new Map<string, LineChanges>();
  for (const { line, text } of plan) {
    const { uri, line: fileLine } = diagram.origins[line]!;
    const lines: LineChanges = byFile.get(uri) ?? new Map();
    byFile.set(uri, lines);
    // A file included twice (!include_many) is one file: its line is edited once.
    if (!lines.has(fileLine)) lines.set(fileLine, text);
  }

  const edits: FileEdit[] = [];
  for (const [uri, changes] of byFile) {
    const file = await read(uri, version);
    const expected = plan.filter(({ line }) => diagram.origins[line]!.uri === uri);
    const stale = expected.some(({ line }) => file?.lines[diagram.origins[line]!.line] !== diagram.lines[line]);
    if (!file || stale) return { ok: false, reason: 'changed', uri };
    edits.push(...textEdits(uri, file, changes));
  }
  return { ok: true, edits };
}

/** An edit of a block of an AsciiDoc document: its lines (inclusive) as rendered, and their new text. */
export interface BlockEdit {
  start: number;
  end: number;
  oldText: string;
  /** The block's new text; blank removes the block, with the blank line separating it from the next. */
  newText: string;
}

/** Applies an edit of a block of the file `uri` made in the AsciiDoc preview. */
export async function editBlock(uri: string, { start, end, oldText, newText }: BlockEdit, version: Version): Promise<Outcome> {
  const file = await read(uri, version);
  if (!file || end >= file.lines.length || file.lines.slice(start, end + 1).join('\n') !== oldText.replace(/\r\n|\r/g, '\n')) {
    return { ok: false, reason: 'changed', uri };
  }
  const changes: LineChanges = new Map();
  for (let line = start; line <= end; line++) changes.set(line, undefined);
  if (newText.trim()) {
    changes.set(start, newText);
  } else {
    // The blank line after the block goes too, unless it is the end of the file.
    const next = end + 1;
    if (next < file.lines.length - 1 && !file.lines[next].trim()) changes.set(next, undefined);
  }
  return { ok: true, edits: textEdits(uri, file, changes) };
}

/** New text by line of a file; undefined deletes the line. */
type LineChanges = Map<number, string | undefined>;

interface FileText {
  lines: string[];
  eol: string;
}

async function read(uri: string, version: Version): Promise<FileText | undefined> {
  try {
    const text = await version.text(vscode.Uri.parse(uri));
    return { lines: text.split(/\r\n|\r|\n/), eol: text.includes('\r\n') ? '\r\n' : '\n' };
  } catch {
    return undefined;
  }
}

/**
 * The text edits making `changes` to a file. Consecutive changed lines become one edit, so edits never touch.
 * Deleting the file's last line also deletes the line break before it, so
 * no empty line is left behind.
 */
function textEdits(uri: string, { lines, eol }: FileText, changes: LineChanges): FileEdit[] {
  const edits: FileEdit[] = [];
  const changed = [...changes.keys()].sort((a, b) => a - b);
  const end = (line: number): FilePosition => ({ line, character: lines[line].length });
  for (let i = 0; i < changed.length; ) {
    let j = i;
    while (j + 1 < changed.length && changed[j + 1] === changed[j] + 1) j++;
    const first = changed[i];
    const last = changed[j];
    const kept = changed.slice(i, j + 1).flatMap((line) => {
      const text = changes.get(line);
      return text === undefined ? [] : [text.replace(/\r\n|\r|\n/g, eol)];
    });
    if (kept.length > 0) {
      edits.push({ uri, start: { line: first, character: 0 }, end: end(last), text: kept.join(eol) });
    } else if (last + 1 < lines.length) {
      edits.push({ uri, start: { line: first, character: 0 }, end: { line: last + 1, character: 0 }, text: '' });
    } else if (first > 0) {
      edits.push({ uri, start: end(first - 1), end: end(last), text: '' });
    } else {
      edits.push({ uri, start: { line: 0, character: 0 }, end: end(last), text: '' });
    }
    i = j + 1;
  }
  return edits;
}
