import * as fs from 'fs';
import * as vscode from 'vscode';
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

/** A Version for one render, reading the real workspace. */
export function workspaceVersion(): Version {
  return new Version(vscodeWorkspace);
}
