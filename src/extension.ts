import * as vscode from 'vscode';
import { registerAsciiDocLanguage } from './asciidocLanguage';
import { PreviewManager } from './previewManager';
import { activeTabUri, EDITOR_VIEW_TYPE, reopenInPlace } from './reopen';

export function activate(context: vscode.ExtensionContext): void {
  const manager = new PreviewManager(context.extensionUri, context.globalState);
  context.subscriptions.push(manager);

  context.subscriptions.push(
    vscode.commands.registerCommand('asciidocPlantumlLive.openPreview', (uri?: vscode.Uri) => openPreview(uri)),
    vscode.commands.registerCommand('asciidocPlantumlLive.openPreviewToSide', (uri?: vscode.Uri) =>
      openPreviewToSide(manager, uri)
    ),
    vscode.commands.registerCommand('asciidocPlantumlLive.editSource', (uri?: vscode.Uri) => editSource(uri)),
    vscode.commands.registerCommand('asciidocPlantumlLive.showSource', (uri?: vscode.Uri) => showSource(uri)),
    vscode.commands.registerCommand('asciidocPlantumlLive.exportSvg', () => manager.exportSvg()),
    vscode.commands.registerCommand('asciidocPlantumlLive.save', () => manager.save()),
    registerAsciiDocLanguage(),
    vscode.window.registerWebviewPanelSerializer(PreviewManager.viewType, manager),
    vscode.window.registerCustomEditorProvider(EDITOR_VIEW_TYPE, manager, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
}

/** Shows the preview in place of the text editor (same tab). */
async function openPreview(uri: vscode.Uri | undefined): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target) {
    vscode.window.showWarningMessage('Open a PlantUML or AsciiDoc file to preview it.');
    return;
  }
  await reopenInPlace(target, 'preview');
}

/** Opens the text editor beside the preview, which stays open and follows the edits. */
async function editSource(uri: vscode.Uri | undefined): Promise<void> {
  const target = uri ?? activeTabUri();
  if (target) {
    await vscode.window.showTextDocument(target, { viewColumn: vscode.ViewColumn.Beside, preview: false });
  }
}

/** Shows the text editor in place of the preview (same tab). */
async function showSource(uri: vscode.Uri | undefined): Promise<void> {
  const target = uri ?? activeTabUri();
  if (target) {
    await reopenInPlace(target, 'text');
  }
}

async function openPreviewToSide(manager: PreviewManager, uri: vscode.Uri | undefined): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri ?? activeTabUri();
  if (!target) {
    vscode.window.showWarningMessage('Open a PlantUML or AsciiDoc file to preview it.');
    return;
  }
  const document = await vscode.workspace.openTextDocument(target);
  manager.showBeside(document, vscode.ViewColumn.Beside);
}

export function deactivate(): void {}
