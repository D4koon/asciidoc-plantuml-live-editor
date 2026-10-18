import * as fs from 'fs';
import * as vscode from 'vscode';
import { FileEdit } from './sourceEdits';
import { fileKey, Version, Workspace } from './versions';

/** The real workspace: VS Code's open documents and file systems. */
export const vscodeWorkspace: Workspace = {
  openText(uri) {
    const key = fileKey(uri);
    return vscode.workspace.textDocuments.find((d) => fileKey(d.uri) === key)?.getText();
  },
  async read(uri) {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  },
  readSync(uri) {
    if (uri.scheme !== 'file') throw new Error(`can't read ${uri.toString()} synchronously`);
    return fs.readFileSync(uri.fsPath, 'utf8');
  },
};

/** Applies text edits to the workspace's documents (they then have unsaved changes). */
export async function applyFileEdits(edits: FileEdit[]): Promise<boolean> {
  const workspaceEdit = new vscode.WorkspaceEdit();
  for (const { uri, start, end, text } of edits) {
    workspaceEdit.replace(vscode.Uri.parse(uri), new vscode.Range(start.line, start.character, end.line, end.character), text);
  }
  return vscode.workspace.applyEdit(workspaceEdit);
}

/** A Version for one render, reading the real workspace. */
export function workspaceVersion(): Version {
  return new Version(vscodeWorkspace);
}
