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

/** The text of `uri`: the open document (with unsaved changes) or what the file system has. */
export async function readText(uri: vscode.Uri): Promise<string> {
  const key = uri.toString();
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  return open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}
