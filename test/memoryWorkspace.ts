import * as vscode from 'vscode';
import { fileKey, Workspace } from '../src/versions';

/**
 * An in-memory workspace for tests: files on disk (and in git refs) and the
 * documents open in editors, each a URI and its text. Files are found the
 * way the real file system finds them (case-insensitive on Windows).
 */
export class MemoryWorkspace implements Workspace {
  private readonly files = new Map<string, string>();
  private readonly open = new Map<string, string>();

  /** Puts `text` on disk (or, for a git URI, in that ref). */
  file(uri: vscode.Uri, text: string): this {
    this.files.set(fileKey(uri), text);
    return this;
  }

  /** Opens `uri` in an editor showing `text` (e.g. with unsaved changes). */
  editor(uri: vscode.Uri, text: string): this {
    this.open.set(fileKey(uri), text);
    return this;
  }

  openText(uri: vscode.Uri): string | undefined {
    return this.open.get(fileKey(uri));
  }

  async read(uri: vscode.Uri): Promise<string> {
    return this.readSync(uri);
  }

  readSync(uri: vscode.Uri): string {
    const text = this.files.get(fileKey(uri));
    if (text === undefined) throw new Error(`ENOENT: ${uri.toString()}`);
    return text;
  }
}

/** A file on disk. */
export function disk(file: string): vscode.Uri {
  return vscode.Uri.file(file);
}

/** `file` at a git ref, as VS Code's git extension names it. */
export function git(file: string, ref: string): vscode.Uri {
  const uri = vscode.Uri.file(file);
  return uri.with({ scheme: 'git', query: JSON.stringify({ path: uri.fsPath, ref }) });
}
