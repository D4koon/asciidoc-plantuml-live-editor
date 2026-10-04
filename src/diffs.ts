import * as vscode from 'vscode';
import { filePathOf, pathKey, Version } from './versions';
import { workspaceVersion } from './vscodeWorkspace';

/**
 * Showing what changed between the two sides of a diff. VS Code opens each
 * side of a diff as its own preview and doesn't say they belong together,
 * so they are paired by file: two previews of the same file, at least one
 * of them a version from git, opened at the same moment.
 */

/** The changes of one file on one side of a diff, by line (zero-based). */
export interface FileChanges {
  /** Lines of this side that the other side doesn't have (changed, added or removed). */
  changed: number[];
  /** For each changed line, the last line of its paragraph (the run of non-blank lines it is in). */
  ends: number[];
  /** Positions where the other side has lines this side lacks: before that line (or at the end). */
  gaps: number[];
  /**
   * Lines in the same paragraph as such lines of the other side (e.g. the
   * paragraph lost its last line): the paragraph changed, though they didn't.
   */
  touched: number[];
}

/** What a preview needs to show the changes of its side. */
export interface DiffMessage {
  type: 'diff';
  /** `old`: the left side (removed text); `new`: the right side (added text). */
  side: 'old' | 'new';
  /** By file URI as this side's preview knows it (the root and its includes). */
  files: Record<string, FileChanges>;
}

/** The part of a preview the pairing needs. */
export interface DiffSide {
  readonly uri: vscode.Uri;
  readonly kind: 'editor' | 'panel';
  readonly created: number;
  /** The URIs of the files the preview shows: its own and the ones it includes. */
  files(): string[];
  readonly onDidUpdate: vscode.Event<void>;
  readonly onDispose: vscode.Event<void>;
  postDiff(message: DiffMessage | { type: 'diff'; side?: undefined } | DiffScroll): void;
  /** Fired when the user scrolls the preview while it is a side of a diff. */
  readonly onDidScroll: vscode.Event<DiffScroll>;
}

/**
 * A scroll position by content: the top of the view is `fraction` of the way
 * into what line `line` of `uri` renders as (a block or diagram), or `gap`
 * pixels above it. `edge` is set at the very top or bottom.
 */
export interface DiffScroll {
  type: 'diffScroll';
  uri?: string;
  line?: number;
  fraction?: number;
  gap?: number;
  edge?: 'top' | 'bottom';
}

/** For one file: which line of the other version each line corresponds to. */
interface Alignment {
  oldUri?: string;
  newUri?: string;
  oldToNew: (line: number) => number;
  newToOld: (line: number) => number;
}

/** How close in time the two sides of a diff are opened. */
const PAIRING_WINDOW_MS = 2000;

export class DiffPairs {
  private readonly pairs = new Map<DiffSide, DiffPair>();

  /** Called for every new preview: pairs it with the other side of its diff, if it is one. */
  add(side: DiffSide, all: Iterable<DiffSide>): void {
    const key = pathKeyOf(side.uri);
    if (!key || side.kind !== 'editor') return;
    const candidates = [...all].filter(
      (other) =>
        other !== side &&
        other.kind === 'editor' &&
        !this.pairs.has(other) &&
        pathKeyOf(other.uri) === key &&
        other.uri.toString() !== side.uri.toString() &&
        (isGit(side.uri) || isGit(other.uri)) &&
        Math.abs(side.created - other.created) < PAIRING_WINDOW_MS
    );
    const other = candidates.sort((a, b) => Math.abs(side.created - a.created) - Math.abs(side.created - b.created))[0];
    if (!other) return;
    // The other side was opened first, so it is the left (original) one unless git says otherwise.
    const [oldSide, newSide] = isOlder(side.uri, other.uri) ? [side, other] : [other, side];
    const pair = new DiffPair(oldSide, newSide, () => {
      this.pairs.delete(oldSide);
      this.pairs.delete(newSide);
    });
    this.pairs.set(oldSide, pair);
    this.pairs.set(newSide, pair);
  }
}

class DiffPair {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  /** By file (path key). */
  private alignments = new Map<string, Alignment>();

  constructor(
    private readonly oldSide: DiffSide,
    private readonly newSide: DiffSide,
    private readonly onDispose: () => void
  ) {
    for (const side of [oldSide, newSide]) {
      this.disposables.push(
        side.onDidUpdate(() => this.schedule()),
        side.onDispose(() => this.dispose()),
        side.onDidScroll((position) => this.scroll(side, position))
      );
    }
    this.schedule();
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.compare(), 100);
  }

  /** Diffs every file either side shows (by path) and sends each side its changes. */
  private async compare(): Promise<void> {
    const byPath = (side: DiffSide) => {
      const files = new Map<string, string>();
      for (const uri of side.files()) {
        const key = pathKeyOf(vscode.Uri.parse(uri));
        if (key && !files.has(key)) files.set(key, uri);
      }
      return files;
    };
    const oldFiles = byPath(this.oldSide);
    const newFiles = byPath(this.newSide);
    const [oldVersion, newVersion] = [workspaceVersion(), workspaceVersion()];
    const read = async (version: Version, uri: string | undefined) => {
      if (!uri) return [];
      try {
        return splitLines(await version.text(vscode.Uri.parse(uri)));
      } catch {
        return []; // not in this version
      }
    };
    const alignments = new Map<string, Alignment>();
    const oldResult: Record<string, FileChanges> = {};
    const newResult: Record<string, FileChanges> = {};
    for (const key of new Set([...oldFiles.keys(), ...newFiles.keys()])) {
      const oldUri = oldFiles.get(key);
      const newUri = newFiles.get(key);
      const [oldLines, newLines] = await Promise.all([read(oldVersion, oldUri), read(newVersion, newUri)]);
      const [oldChanges, newChanges] = diffLines(oldLines, newLines);
      if (oldUri) oldResult[oldUri] = oldChanges;
      if (newUri) newResult[newUri] = newChanges;
      alignments.set(key, {
        oldUri,
        newUri,
        oldToNew: aligner(oldChanges.changed, oldLines.length, newChanges.changed, newLines.length),
        newToOld: aligner(newChanges.changed, newLines.length, oldChanges.changed, oldLines.length),
      });
    }
    if (this.disposed) return;
    this.alignments = alignments;
    this.oldSide.postDiff({ type: 'diff', side: 'old', files: oldResult });
    this.newSide.postDiff({ type: 'diff', side: 'new', files: newResult });
  }

  /** Scrolls the other side to the content `from` shows at its top. */
  private scroll(from: DiffSide, position: DiffScroll): void {
    const toNew = from === this.oldSide;
    const other = toNew ? this.newSide : this.oldSide;
    if (position.edge || position.uri === undefined || position.line === undefined) {
      other.postDiff(position);
      return;
    }
    const key = pathKeyOf(vscode.Uri.parse(position.uri));
    const alignment = key ? this.alignments.get(key) : undefined;
    const uri = toNew ? alignment?.newUri : alignment?.oldUri;
    if (!alignment || !uri) return; // a file only this side has
    const line = (toNew ? alignment.oldToNew : alignment.newToOld)(position.line);
    other.postDiff({ ...position, uri, line });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
    this.onDispose();
    // The side still open is no longer part of a diff (e.g. VS Code reused it).
    for (const side of [this.oldSide, this.newSide]) side.postDiff({ type: 'diff' });
  }
}

/**
 * Maps lines of one version to the other: unchanged lines to their partner
 * (they pair up in order), changed ones to the same distance after the
 * partner of the unchanged line before them.
 */
export function aligner(changedA: number[], lengthA: number, changedB: number[], lengthB: number): (line: number) => number {
  const skipA = new Set(changedA);
  const skipB = new Set(changedB);
  const keptB: number[] = [];
  for (let j = 0; j < lengthB; j++) if (!skipB.has(j)) keptB.push(j);
  /** For each line of A: its partner in B, or -1 for changed lines. */
  const partner: number[] = [];
  let k = 0;
  for (let i = 0; i < lengthA; i++) partner.push(skipA.has(i) ? -1 : (keptB[k++] ?? -1));
  return (line) => {
    if (line < 0 || line >= lengthA) return Math.max(0, Math.min(line, lengthB - 1));
    if (partner[line] >= 0) return partner[line];
    let before = line - 1;
    while (before >= 0 && partner[before] < 0) before--;
    let after = line + 1;
    while (after < lengthA && partner[after] < 0) after++;
    const base = before >= 0 ? partner[before] + (line - before) : line;
    const limit = after < lengthA ? partner[after] : lengthB;
    return Math.max(0, Math.min(base, limit - 1, lengthB - 1));
  };
}

function isGit(uri: vscode.Uri): boolean {
  return uri.scheme === 'git';
}

/** The git ref a version is at; '' and '~' are the index. */
function refOf(uri: vscode.Uri): string | undefined {
  if (!isGit(uri)) return undefined;
  try {
    return String(JSON.parse(uri.query).ref ?? '');
  } catch {
    return '';
  }
}

/**
 * Whether `a` is the older version of the two: a commit is older than the
 * index, which is older than the working copy. Two commits can't be told
 * apart here; then the one opened first (`b`) counts as the older one.
 */
function isOlder(a: vscode.Uri, b: vscode.Uri): boolean {
  const rank = (uri: vscode.Uri) => {
    const ref = refOf(uri);
    return ref === undefined ? 2 : ref === '' || ref === '~' ? 1 : 0;
  };
  return rank(a) < rank(b);
}

/** The file `uri` is a version of, for pairing it with its other version. */
function pathKeyOf(uri: vscode.Uri): string | undefined {
  const file = filePathOf(uri);
  return file === undefined ? undefined : pathKey(file);
}

function splitLines(text: string): string[] {
  return text === '' ? [] : text.split(/\r\n|\r|\n/);
}

/** Above this many cells, the middle of two files is marked changed as a whole instead of diffed. */
const MAX_CELLS = 4_000_000;

/** A line diff (longest common subsequence): the changes of each side. */
export function diffLines(a: string[], b: string[]): [FileChanges, FileChanges] {
  const changedA: number[] = [];
  const changedB: number[] = [];
  const gapsA: number[] = [];
  const gapsB: number[] = [];
  const touchedA: number[] = [];
  const touchedB: number[] = [];
  const text = (lines: string[], i: number) => !!lines[i]?.trim();

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;

  /** Records a hunk: lines [i0, i1) of `a` replaced by [j0, j1) of `b`. */
  const hunk = (i0: number, i1: number, j0: number, j1: number) => {
    for (let i = i0; i < i1; i++) changedA.push(i);
    for (let j = j0; j < j1; j++) changedB.push(j);
    if (i0 === i1 && j1 > j0) {
      gapsA.push(i0);
      if (text(b, j0) && text(a, i0 - 1)) touchedA.push(i0 - 1);
      if (text(b, j1 - 1) && text(a, i0)) touchedA.push(i0);
    }
    if (j0 === j1 && i1 > i0) {
      gapsB.push(j0);
      if (text(a, i0) && text(b, j0 - 1)) touchedB.push(j0 - 1);
      if (text(a, i1 - 1) && text(b, j0)) touchedB.push(j0);
    }
  };

  if (n > 0 || m > 0) {
    if (n === 0 || m === 0 || n * m > MAX_CELLS) {
      hunk(start, endA, start, endB);
    } else {
      // lcs[i][j]: length of the common subsequence of a[start+i..endA) and b[start+j..endB).
      const width = m + 1;
      const lcs = new Uint32Array((n + 1) * width);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          lcs[i * width + j] =
            a[start + i] === b[start + j]
              ? lcs[(i + 1) * width + j + 1] + 1
              : Math.max(lcs[(i + 1) * width + j], lcs[i * width + j + 1]);
        }
      }
      let i = 0;
      let j = 0;
      let hi = 0;
      let hj = 0;
      while (i < n || j < m) {
        if (i < n && j < m && a[start + i] === b[start + j]) {
          if (hi < i || hj < j) hunk(start + hi, start + i, start + hj, start + j);
          i++;
          j++;
          hi = i;
          hj = j;
        } else if (j < m && (i === n || lcs[i * width + j + 1] >= lcs[(i + 1) * width + j])) {
          j++;
        } else {
          i++;
        }
      }
      if (hi < n || hj < m) hunk(start + hi, endA, start + hj, endB);
    }
  }
  return [withEnds(changedA, gapsA, touchedA, a), withEnds(changedB, gapsB, touchedB, b)];
}

function withEnds(changed: number[], gaps: number[], touched: number[], lines: string[]): FileChanges {
  const ends = changed.map((line) => {
    let end = line;
    while (lines[end]?.trim() && end + 1 < lines.length && lines[end + 1].trim()) end++;
    return end;
  });
  return { changed, ends, gaps, touched };
}
