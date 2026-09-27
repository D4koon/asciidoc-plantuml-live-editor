import * as vscode from 'vscode';

/** View type of the custom editor that renders PlantUML files in place. */
export const EDITOR_VIEW_TYPE = 'asciidocPlantumlLive.editor';

/**
 * Switches the active tab showing `uri` between the text editor and the
 * preview. Uses the command behind "Reopen Editor With…", which replaces the
 * editor in the same tab and keeps unsaved changes; closing and reopening the
 * tab ourselves would discard them.
 */
export async function reopenInPlace(uri: vscode.Uri, mode: 'text' | 'preview'): Promise<void> {
  const editorId = mode === 'text' ? 'default' : EDITOR_VIEW_TYPE;
  if (uri.toString() === activeTabUri()?.toString()) {
    await vscode.commands.executeCommand('reopenActiveEditorWith', editorId);
  } else {
    await vscode.commands.executeCommand('vscode.openWith', uri, editorId);
  }
}

/** The file shown by the active tab, if it is a text editor or custom editor. */
export function activeTabUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) {
    return input.uri;
  }
  return undefined;
}
