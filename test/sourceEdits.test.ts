import * as vscode from 'vscode';
import { describe, expect, it } from 'vitest';
import { LineEdit, planDelete, planRename } from '../src/diagramEdits';
import { Diagram } from '../src/diagrams';
import { editBlock, editDiagram, FileEdit, Outcome } from '../src/sourceEdits';
import { Version } from '../src/versions';
import { disk, MemoryWorkspace, origin } from './memoryWorkspace';

const MAIN = disk('/project/main.puml');

/** A Diagram of `files` as the engine saw them: each [uri, line] of the files' texts, or a line the engine added. */
function diagramOf(files: Map<vscode.Uri, string>, lines: ([vscode.Uri, number] | string)[]): Diagram {
  const textOf = (uri: vscode.Uri, line: number) => files.get(uri)!.split(/\r\n|\n/)[line];
  return {
    lines: lines.map((l) => (typeof l === 'string' ? l : textOf(...l))),
    origins: lines.map((l) => (typeof l === 'string' ? null : origin(...l))),
  };
}

/** The files' texts after applying `outcome`'s edits. */
function applied(files: Map<vscode.Uri, string>, outcome: Outcome): Map<string, string> {
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

function workspaceOf(files: Map<vscode.Uri, string>): MemoryWorkspace {
  const workspace = new MemoryWorkspace();
  files.forEach((text, uri) => workspace.file(uri, text));
  return workspace;
}

describe('Editing a Diagram', () => {
  it('renames across the files the diagram includes', async () => {
    const actors = disk('/project/actors.iuml');
    const files = new Map([
      [MAIN, '@startuml\n!include actors.iuml\nAlice -> Bob\n@enduml\n'],
      [actors, 'participant Alice\n'],
    ]);
    const diagram = diagramOf(files, [[MAIN, 0], [actors, 0], [MAIN, 2], [MAIN, 3]]);
    const plan: LineEdit[] = [
      { line: 1, text: 'participant Carol' },
      { line: 2, text: 'Carol -> Bob' },
    ];

    const outcome = await editDiagram(diagram, plan, new Version(workspaceOf(files)));

    expect(applied(files, outcome)).toEqual(
      new Map([
        [MAIN.toString(), '@startuml\n!include actors.iuml\nCarol -> Bob\n@enduml\n'],
        [actors.toString(), 'participant Carol\n'],
      ])
    );
  });

  it('renames a participant declared in an included file everywhere, with the rename planner', async () => {
    const actors = disk('/project/actors.iuml');
    const files = new Map([
      [MAIN, '@startuml\n!include actors.iuml\nAlice -> Bob : hello Alice\n@enduml\n'],
      [actors, 'participant Alice\nparticipant Bob\n'],
    ]);
    const diagram = diagramOf(files, [[MAIN, 0], [actors, 0], [actors, 1], [MAIN, 2], [MAIN, 3]]);
    const plan = planRename(diagram.lines, { kind: 'name', qualifiedName: 'Alice', oldText: 'Alice', newText: 'Carol', texts: ['Alice'] });

    const outcome = await editDiagram(diagram, plan, new Version(workspaceOf(files)));

    expect(applied(files, outcome)).toEqual(
      new Map([
        [MAIN.toString(), '@startuml\n!include actors.iuml\nCarol -> Bob : hello Alice\n@enduml\n'],
        [actors.toString(), 'participant Carol\nparticipant Bob\n'],
      ])
    );
  });

  it('deletes the message at the line the SVG names, with the delete planner', async () => {
    const files = new Map([[MAIN, 'A -> B\nA -> B\n']]);
    const diagram = diagramOf(files, ['@startuml', [MAIN, 0], [MAIN, 1], '@enduml']);
    const plan = planDelete(diagram.lines, { hint: 2, texts: [] });

    const outcome = await editDiagram(diagram, plan, new Version(workspaceOf(files)));

    expect(applied(files, outcome).get(MAIN.toString())).toBe('A -> B\n');
  });

  const edit = async (text: string, lines: number[], plan: LineEdit[]) => {
    const files = new Map([[MAIN, text]]);
    const diagram = diagramOf(files, lines.map((line): [vscode.Uri, number] => [MAIN, line]));
    return applied(files, await editDiagram(diagram, plan, new Version(workspaceOf(files)))).get(MAIN.toString());
  };

  it('deletes a line', async () => {
    expect(await edit('@startuml\nA -> B\nB -> C\n@enduml\n', [0, 1, 2, 3], [{ line: 1, text: undefined }])).toBe(
      '@startuml\nB -> C\n@enduml\n'
    );
  });

  it('deleting a file’s last line leaves no empty line behind', async () => {
    expect(await edit('A -> B\nB -> C', [0, 1], [{ line: 1, text: undefined }])).toBe('A -> B');
  });

  it('keeps the line break that ends a file', async () => {
    expect(await edit('A -> B\nB -> C\n', [0, 1], [{ line: 1, text: undefined }])).toBe('A -> B\n');
  });

  it('deleting the only line leaves an empty file', async () => {
    expect(await edit('A -> B', [0], [{ line: 0, text: undefined }])).toBe('');
  });

  it('deletes consecutive lines, also at the end of a file', async () => {
    expect(await edit('A\nB\nC', [0, 1, 2], [{ line: 1, text: undefined }, { line: 2, text: undefined }])).toBe('A');
  });

  it('keeps the file’s line breaks', async () => {
    expect(await edit('A\r\nB\r\nC\r\n', [0, 1, 2], [{ line: 1, text: 'B2' }, { line: 2, text: undefined }])).toBe('A\r\nB2\r\n');
  });

  it('edits a line of a file included many times once', async () => {
    const part = disk('/project/part.iuml');
    const files = new Map([
      [MAIN, '@startuml\n!include_many part.iuml\n!include_many part.iuml\n@enduml'],
      [part, 'A -> B'],
    ]);
    const diagram = diagramOf(files, [[MAIN, 0], [part, 0], [part, 0], [MAIN, 3]]);
    const plan: LineEdit[] = [
      { line: 1, text: 'A -> C' },
      { line: 2, text: 'A -> C' },
    ];

    const outcome = await editDiagram(diagram, plan, new Version(workspaceOf(files)));

    expect(applied(files, outcome).get(part.toString())).toBe('A -> C');
  });

  it('refuses an edit of a line the engine was given without it being written anywhere', async () => {
    const files = new Map([[MAIN, 'A -> B']]);
    const diagram = diagramOf(files, ['@startuml', [MAIN, 0], '@enduml']);

    const outcome = await editDiagram(diagram, [{ line: 0, text: '@startmindmap' }], new Version(workspaceOf(files)));

    expect(outcome).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses when the plan found nothing', async () => {
    const files = new Map([[MAIN, 'A -> B']]);

    const outcome = await editDiagram(diagramOf(files, [[MAIN, 0]]), undefined, new Version(workspaceOf(files)));

    expect(outcome).toEqual({ ok: false, reason: 'not-found' });
  });

  it('refuses the whole edit when a file changed since the preview was rendered', async () => {
    const actors = disk('/project/actors.iuml');
    const files = new Map([
      [MAIN, '@startuml\n!include actors.iuml\nAlice -> Bob\n@enduml'],
      [actors, 'participant Alice'],
    ]);
    const diagram = diagramOf(files, [[MAIN, 0], [actors, 0], [MAIN, 2], [MAIN, 3]]);
    const workspace = workspaceOf(files).editor(actors, 'participant Alicia');
    const plan: LineEdit[] = [
      { line: 1, text: 'participant Carol' },
      { line: 2, text: 'Carol -> Bob' },
    ];

    const outcome = await editDiagram(diagram, plan, new Version(workspace));

    expect(outcome).toEqual({ ok: false, reason: 'changed', uri: actors.toString() });
  });
});

describe('Editing an AsciiDoc block', () => {
  const DOC = disk('/project/main.adoc');
  const TEXT = '= Title\n\nFirst paragraph\nstill first.\n\nSecond paragraph.\n';

  const edit = async (text: string, block: { start: number; end: number; oldText: string; newText: string }) => {
    const files = new Map([[DOC, text]]);
    const outcome = await editBlock(DOC.toString(), block, new Version(workspaceOf(files)));
    return outcome.ok ? applied(files, outcome).get(DOC.toString()) : outcome;
  };

  it('replaces the block’s lines with the new text', async () => {
    expect(await edit(TEXT, { start: 2, end: 3, oldText: 'First paragraph\nstill first.', newText: 'One line now.' })).toBe(
      '= Title\n\nOne line now.\n\nSecond paragraph.\n'
    );
  });

  it('removes a block with the blank line separating it from the next', async () => {
    expect(await edit(TEXT, { start: 2, end: 3, oldText: 'First paragraph\nstill first.', newText: '' })).toBe(
      '= Title\n\nSecond paragraph.\n'
    );
  });

  it('removes the last block, keeping the line break that ends the file', async () => {
    expect(await edit(TEXT, { start: 5, end: 5, oldText: 'Second paragraph.', newText: '  ' })).toBe(
      '= Title\n\nFirst paragraph\nstill first.\n\n'
    );
  });

  it('refuses when the block changed since the preview was rendered', async () => {
    expect(await edit(TEXT, { start: 2, end: 3, oldText: 'First paragraph\nstill 1st.', newText: 'x' })).toEqual({
      ok: false,
      reason: 'changed',
      uri: DOC.toString(),
    });
  });
});
