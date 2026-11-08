import * as vscode from 'vscode';
import { FileEdit, Outcome } from '../src/sourceEdits';

/** The files' texts after applying `outcome`'s edits. */
export function applied(files: Map<vscode.Uri, string>, outcome: Outcome): Map<string, string> {
  if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
  const result = new Map([...files].map(([uri, text]) => [uri.toString(), text]));
  const offset = (text: string, { line, character }: FileEdit['start']) => {
    const lines = text.split(/(?<=\n)/);
    return lines.slice(0, line).reduce((sum, l) => sum + l.length, 0) + character;
  };
  // Back to front, so earlier offsets stay valid.
  const edits = [...outcome.edits].sort((a, b) => b.start.line - a.start.line || b.start.character - a.start.character);
  for (const edit of edits) {
    const text = result.get(edit.uri)!;
    result.set(edit.uri, text.slice(0, offset(text, edit.start)) + edit.text + text.slice(offset(text, edit.end)));
  }
  return result;
}
