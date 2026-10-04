import * as path from 'path';
import * as vscode from 'vscode';

/**
 * Documents don't always come from disk: in diffs, the old side is a version
 * from git (a `git:` URI whose query names the file and the ref). Its
 * includes must come from the same version, and it can't be edited.
 */

interface GitQuery {
  path: string;
  ref?: string;
}

function gitQuery(uri: vscode.Uri): GitQuery | undefined {
  if (uri.scheme !== 'git') return undefined;
  try {
    const query: unknown = JSON.parse(uri.query);
    return query && typeof (query as GitQuery).path === 'string' ? (query as GitQuery) : undefined;
  } catch {
    return undefined;
  }
}

/** The file system path a document stands for: its own, or the file a git version is of. */
export function filePathOf(uri: vscode.Uri): string | undefined {
  return uri.scheme === 'file' ? uri.fsPath : gitQuery(uri)?.path;
}

/** The URI of `file` in the same version as `uri`: the same git ref, or the file on disk. */
export function uriInVersion(uri: vscode.Uri, file: string): vscode.Uri {
  const target = vscode.Uri.file(file);
  const query = gitQuery(uri);
  return query ? target.with({ scheme: uri.scheme, query: JSON.stringify({ ...query, path: target.fsPath }) }) : target;
}

/** The URI of `relative` (a path as written in an include) next to `base`, in the same version. */
export function relativeUri(base: vscode.Uri, relative: string): vscode.Uri {
  const file = gitQuery(base)?.path;
  return file ? uriInVersion(base, path.resolve(path.dirname(file), relative)) : vscode.Uri.joinPath(base, '..', relative);
}

/** Whether a document is a version that can't be edited (e.g. the old side of a diff). */
export function isReadOnly(uri: vscode.Uri): boolean {
  return !!gitQuery(uri) || (uri.scheme !== 'untitled' && vscode.workspace.fs.isWritableFileSystem(uri.scheme) === false);
}

/**
 * Where a Version gets text from: the documents open in editors, and the file
 * systems (the disk, and git refs through VS Code's git file system).
 */
export interface Workspace {
  /** The text of the editor document for `uri`, unsaved changes included, if one is open. */
  openText(uri: vscode.Uri): string | undefined;
  /** What the file system has for `uri`; throws if there is no such file. */
  read(uri: vscode.Uri): Promise<string>;
  /** The same, synchronously; only files on disk can be read this way. */
  readSync(uri: vscode.Uri): string;
}

/**
 * The files one render reads, all from the same Version: a file open in an
 * editor is read from the editor, unsaved changes included; any other file
 * from its file system. Each file is read once and recorded, so a render
 * sees one consistent text per file and knows everything it depends on.
 */
export class Version {
  /** By `fileKey`. */
  private readonly texts = new Map<string, { uri: vscode.Uri; text: string }>();

  constructor(private readonly workspace: Workspace) {}

  /** The text of `uri`; throws if it can't be read. */
  async text(uri: vscode.Uri): Promise<string> {
    const known = this.texts.get(fileKey(uri));
    if (known) return known.text;
    return this.remember(uri, this.workspace.openText(uri) ?? (await this.workspace.read(uri)));
  }

  /**
   * The text of `uri`, read synchronously (Asciidoctor reads includes that
   * way); undefined if it can't be read. Only files on disk can be read on
   * the spot: a git version's files must have been read with `text` first.
   */
  textSync(uri: vscode.Uri): string | undefined {
    const known = this.texts.get(fileKey(uri));
    if (known) return known.text;
    const open = this.workspace.openText(uri);
    if (open !== undefined) return this.remember(uri, open);
    if (uri.scheme !== 'file') return undefined;
    try {
      return this.remember(uri, this.workspace.readSync(uri));
    } catch {
      return undefined;
    }
  }

  /** Whether `uri` is open in an editor, so its text may differ from the file's. */
  isOpen(uri: vscode.Uri): boolean {
    return this.workspace.openText(uri) !== undefined;
  }

  /** Whether `uri` is one of the files read. */
  hasRead(uri: vscode.Uri): boolean {
    return this.texts.has(fileKey(uri));
  }

  /** The files read, in the order they were first read. */
  files(): vscode.Uri[] {
    return [...this.texts.values()].map(({ uri }) => uri);
  }

  private remember(uri: vscode.Uri, text: string): string {
    this.texts.set(fileKey(uri), { uri, text });
    return text;
  }
}

/**
 * Identifies a file within its Version: two URIs are the same file when this
 * is equal. Paths ignore case on Windows, like its file system does.
 */
export function fileKey(uri: vscode.Uri): string {
  const file = filePathOf(uri);
  if (file === undefined) return uri.toString();
  const query = gitQuery(uri);
  return `${query ? `git:${query.ref ?? ''}` : 'file'}|${pathKey(file)}`;
}

/** Whether two file system paths name the same file (ignoring case on Windows). */
export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** A file system path normalized for comparison, whatever its Version. */
export function pathKey(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
